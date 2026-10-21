import test from 'node:test';
import assert from 'node:assert/strict';
import {ReplayStore,ADMIN_ID} from '../lib/discord/store.js';
import {RecentPublisher,findRecentMessage,editRecentMessage} from '../lib/discord/recent.js';
import {recentComponents} from '../lib/discord/recent-controls.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {game} from './fixtures/discord-game.js';
const channelId='1553267567559442572';
test('recent backfill includes plain IGNs, is chronological and persistent; new games follow without rescore duplicates',async t=>{
  const store=new ReplayStore(':memory:');t.after(()=>store.close());
  store.importGame(game({index:1}));store.importGame(game({index:2}));
  const sent=[],cards={gameAttachment:async g=>({name:`game-${g.id}.png`})};
  const options={store,cards,channelId,send:async(channel,payload)=>{sent.push({channel,payload});return {id:String(sent.length)};}};
  const first=new RecentPublisher(options);
  await Promise.all([first.tick(),first.tick()]);await first.tick();
  assert.equal(sent.length,2);assert.deepEqual(sent[0].payload.files,[{name:'game-1.png'}]);
  assert.equal(sent[0].payload.content,'Sputtered Mikowa');assert.equal(sent[0].payload.embeds,undefined);
  assert.deepEqual(sent[0].payload.components[0].components.map(b=>b.label),['Sputtered','Mikowa']);
  const restarted=new RecentPublisher(options);await restarted.tick();assert.equal(sent.length,2);
  store.importGame(game({index:3}));await restarted.tick();assert.equal(sent.length,3);
  assert.equal(new Set(sent.map(x=>x.payload.nonce)).size,3);
  assert.ok(sent.every(x=>x.channel===channelId && x.payload.enforceNonce));
});
test('uncertain send is reconciled after restart, with no duplicate or skipped game',async t=>{
  let now=new Date('2026-09-25T00:00:00Z');const store=new ReplayStore(':memory:',{now:()=>now});t.after(()=>store.close());
  store.importGame(game({index:1}));let calls=0,lookups=0;
  const options={store,channelId,cards:{gameAttachment:async()=>({})},log:()=>{},
    send:async()=>{calls++;throw Error('Response lost');},findSent:async()=>{lookups++;return '123';}};
  await new RecentPublisher(options).tick();now=new Date(now.getTime()+600_000);
  await new RecentPublisher(options).tick();assert.equal(calls,1);assert.equal(lookups,1);
  assert.equal(store.db.prepare('SELECT message_id FROM recent_posts').get().message_id,'123');
});
test('history failure prevents blind resend, and absent messages retry with the same nonce',async t=>{
  let now=new Date('2026-09-25T00:00:00Z');const store=new ReplayStore(':memory:',{now:()=>now});t.after(()=>store.close());
  store.importGame(game({index:1}));const nonces=[];let historyFails=true;
  const p=new RecentPublisher({store,channelId,cards:{gameAttachment:async()=>({})},log:()=>{},
    send:async(_,payload)=>{nonces.push(payload.nonce);if(nonces.length===1)throw Error('Response lost');return {id:'456'};},
    findSent:async()=>{if(historyFails)throw Error('Missing history permission');return null;}});
  await p.tick();now=new Date(now.getTime()+60_000);await p.tick();assert.equal(nonces.length,1);
  historyFails=false;now=new Date(now.getTime()+60_000);await p.tick();assert.equal(nonces.length,2);assert.equal(nonces[0],nonces[1]);
});
test('history reconciliation matches only this bot and the exact game attachment',async()=>{
  const messages=new Map([['12',{id:'12',createdTimestamp:Date.now(),author:{id:'bot'},attachments:new Map([['a',{name:'game-G00001.png'}]])}]]);
  assert.equal(await findRecentMessage({messages:{fetch:async()=>messages}},{game_id:1,first_attempt_at:new Date().toISOString()},'bot'),'12');
  assert.equal(await findRecentMessage({messages:{fetch:async()=>messages}},{game_id:1,first_attempt_at:new Date().toISOString()},'someone'),null);
});

test('separate admin connection, undo and rescores refresh the original message across restarts',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'scority-recent-')),store=new ReplayStore(join(dir,'test.sqlite'));
  const web=new ReplayStore(join(dir,'test.sqlite'));t.after(()=>{web.close();store.close();rmSync(dir,{recursive:true});});
  const job=store.submit('111111111111111111','refresh-replay');store.claimNext();store.complete(job.id,game());
  const sent=[],edited=[],options={store,channelId,refreshInterval:0,cards:{gameAttachment:async g=>g},
    send:async(_,payload)=>{sent.push(payload);return {id:'original-message'};},
    edit:async(_,post,payload)=>edited.push({post,payload})};
  const publisher=new RecentPublisher(options);await publisher.tick();
  let draft=web.gameEditor(1);draft.draft.players[0].kills=17;draft.draft.players[0].name='RealName';draft.draft.winner='green';
  draft=web.saveGameEditor(ADMIN_ID,1,draft.version,draft.draft);await publisher.tick();
  assert.equal(edited[0].post.message_id,'original-message');assert.deepEqual(edited[0].payload.attachments,[]);
  assert.equal(edited[0].payload.files[0].payload.players.RealName.kills,17);
  assert.equal(edited[0].payload.content,'RealName Mikowa');
  assert.equal(edited[0].payload.components[0].components[0].label,'RealName');
  assert.equal(edited[0].payload.components[0].components[0].custom_id,'rp:public:gameplayer:G00001,Sputtered');
  assert.equal(edited[0].payload.files[0].payload.match.winner,'green');
  web.restoreGameEditor(ADMIN_ID,1,draft.version,draft.history[0].id);
  await new RecentPublisher(options).tick();assert.equal(edited[1].payload.files[0].payload.players.Sputtered.kills,2);
  assert.equal(edited[1].payload.content,'Sputtered Mikowa');
  web.rescore(ADMIN_ID,'G1');store.claimNext();store.complete(job.id,game({kills:4}));
  const restarted=new RecentPublisher(options);await restarted.tick();await restarted.tick();
  assert.equal(edited.length,3);assert.equal(edited[2].payload.files[0].payload.players.Sputtered.kills,4);
  assert.equal(sent.length,1);assert.ok(edited.every(e=>e.post.message_id==='original-message'));
});

test('existing image receipts gain raw IGN content without replacing images and persist across restarts',async t=>{
  const store=new ReplayStore(':memory:');t.after(()=>store.close());const data=game();
  data.players.Player_One=data.players.Sputtered;delete data.players.Sputtered;store.importGame(data);
  let renders=0,edits=0;const options={store,channelId,refreshInterval:0,cards:{gameAttachment:async()=>{renders++;return {}; }},
    send:async()=>({id:'existing'}),edit:async(_,post,payload)=>{
      edits++;assert.equal(post.message_id,'existing');assert.equal(payload.content,'Mikowa Player_One');
      assert.equal(payload.files,undefined);assert.equal(payload.attachments,undefined);assert.deepEqual(payload.allowedMentions,{parse:[]});
    }};
  await new RecentPublisher(options).tick();
  store.db.exec('ALTER TABLE recent_posts DROP COLUMN content_text');
  await new RecentPublisher(options).tick();await new RecentPublisher(options).tick();
  assert.equal(edits,1);assert.equal(renders,1);
  assert.equal(store.db.prepare('SELECT content_text FROM recent_posts').get().content_text,'Mikowa Player_One');
});

test('existing cards gain player controls without replacing their image or raw names',async t=>{
  const store=new ReplayStore(':memory:');t.after(()=>store.close());store.importGame(game());let renders=0,edits=0;
  const options={store,channelId,refreshInterval:0,cards:{gameAttachment:async()=>{renders++;return {};}},
    send:async()=>({id:'original'}),edit:async(_,post,payload)=>{
      edits++;assert.equal(post.message_id,'original');assert.equal(payload.content,'Sputtered Mikowa');
      assert.equal(payload.files,undefined);assert.equal(payload.attachments,undefined);
      assert.deepEqual(payload.components,recentComponents(store.getGame(1)));
    }};
  await new RecentPublisher(options).tick();store.db.exec('ALTER TABLE recent_posts DROP COLUMN components_json');
  await new RecentPublisher(options).tick();await new RecentPublisher(options).tick();
  assert.equal(edits,1);assert.equal(renders,1);
});

test('player controls fit Discord rows, preserve original identities and expose large rosters',()=>{
  const p=game();p.players=Object.fromEntries(Array.from({length:32},(_,i)=>[`Player${i}`,{team:i<16?'red':'green'}]));
  const g={id:7,payload:p,voided:false},rows=recentComponents(g),buttons=rows.flatMap(r=>r.components);
  assert.equal(rows.length,5);assert.ok(rows.every(r=>r.components.length<=5));
  assert.equal(buttons.length,25);assert.equal(buttons.at(-1).label,'More players');
  assert.equal(buttons.at(-1).custom_id,'rp:public:gameplayers:G00007');
  assert.ok(buttons.every(b=>b.custom_id.length<=100));
  g.voided=true;assert.ok(recentComponents(g).flatMap(r=>r.components).every(b=>b.disabled));
});

test('failed refresh persists backoff without blocking new posts or sending replacements',async t=>{
  let now=new Date('2026-09-25T00:00:00Z');const store=new ReplayStore(':memory:',{now:()=>now});t.after(()=>store.close());
  store.importGame(game());let sends=0,edits=0,fail=true;
  const options={store,channelId,refreshInterval:0,log:()=>{},cards:{gameAttachment:async()=>({})},
    send:async()=>({id:String(++sends)}),edit:async()=>{edits++;if(fail)throw Error('Missing message');}};
  const p=new RecentPublisher(options);await p.tick();const d=store.gameEditor(1);d.draft.players[0].kills=8;store.saveGameEditor(ADMIN_ID,1,d.version,d.draft);
  await p.tick();assert.equal(edits,1);assert.match(store.db.prepare('SELECT error FROM recent_posts').get().error,/Missing message/);
  store.importGame(game({index:2}));const restarted=new RecentPublisher(options);await restarted.tick();await restarted.tick();
  assert.equal(sends,2);assert.equal(edits,1);
  fail=false;now=new Date(now.getTime()+60_000);await new RecentPublisher(options).tick();assert.equal(edits,2);assert.equal(sends,2);
  assert.equal(store.db.prepare('SELECT error FROM recent_posts WHERE game_id=1').get().error,null);
});

test('a change during rendering is not marked as already published',async t=>{
  const store=new ReplayStore(':memory:');t.after(()=>store.close());store.importGame(game());let renders=0,edits=0;
  const p=new RecentPublisher({store,channelId,refreshInterval:0,
    cards:{gameAttachment:async g=>{if(++renders===1){const d=store.gameEditor(1);d.draft.players[0].kills=6;store.saveGameEditor(ADMIN_ID,1,d.version,d.draft);}return g;}},
    send:async()=>({id:'1'}),edit:async(_,post,payload)=>{edits++;assert.equal(payload.files[0].payload.players.Sputtered.kills,6);}});
  await p.tick();await p.tick();await p.tick();assert.equal(edits,1);
});

test('legacy receipts refresh in place and Discord edits verify bot ownership and game attachment',async t=>{
  const store=new ReplayStore(':memory:');t.after(()=>store.close());store.importGame(game());
  store.db.exec(`CREATE TABLE recent_posts(channel_id TEXT,game_id INTEGER,status TEXT,attempts INTEGER,first_attempt_at TEXT,next_at TEXT,message_id TEXT,error TEXT,PRIMARY KEY(channel_id,game_id))`);
  store.db.prepare("INSERT INTO recent_posts VALUES(?,1,'sent',0,NULL,'2026-01-01','old-message',NULL)").run(channelId);
  let edits=0;const message={author:{id:'bot'},attachments:new Map([['a',{name:'game-G00001.png'}]]),edit:async()=>edits++};
  const channel={messages:{fetch:async id=>{assert.equal(id,'old-message');return message;}}};
  const p=new RecentPublisher({store,channelId,refreshInterval:0,cards:{gameAttachment:async()=>({})},
    send:async()=>assert.fail('Must not repost'),edit:async(_,post,payload)=>editRecentMessage(channel,post,'bot',payload)});
  await p.tick();await p.tick();assert.equal(edits,1);
  const post={message_id:'old-message',game_id:1};
  message.author.id='other';await assert.rejects(editRecentMessage(channel,post,'bot',{}),/does not match/);
  message.author.id='bot';message.attachments.clear();await assert.rejects(editRecentMessage(channel,post,'bot',{}),/does not match/);
  assert.equal(edits,1);
});
