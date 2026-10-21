import test from 'node:test';
import assert from 'node:assert/strict';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {AvatarCache} from '../lib/discord/cards/avatars.js';
import {ImageCards} from '../lib/discord/cards/service.js';
import {renderPlayerCard,renderGameCard,STYLES} from '../lib/discord/cards/render.js';
import {ReplayStore,ADMIN_ID} from '../lib/discord/store.js';
import {DiscordUI} from '../lib/discord/ui.js';
import {RecorderBridge} from '../lib/discord/recorder.js';
import {createInteractionHandler} from '../lib/discord/interactions.js';
import {CompletionNotifier} from '../lib/discord/notifications.js';
import {playerStats} from '../lib/discord/stats.js';
import {game} from './fixtures/discord-game.js';
import {recentComponents} from '../lib/discord/recent-controls.js';
const USER='111111111111111111';
const offlineAvatars={many:async()=>new Map()};
function fixture(t) {
  const store=new ReplayStore(':memory:');t.after(()=>store.close());store.whitelist(ADMIN_ID,USER);
  const ui=new DiscordUI(store,new RecorderBridge(store,{log:()=>{}}));
  const cards=new ImageCards({store,avatars:offlineAvatars,log:()=>{}});
  return {store,ui,cards};
}
async function imageInfo(buffer) {
  assert.ok(buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
  assert.ok(buffer.length<7*1024*1024);const image=await loadImage(buffer);
  return {width:image.width,height:image.height};
}
function interaction(user,command,args={},kind='command',customId='') {
  return {user:{id:user},commandName:command,customId,options:{data:Object.entries(args).map(([name,value])=>({name,value}))},
    isChatInputCommand:()=>kind==='command',isAutocomplete:()=>false,isButton:()=>kind==='button',isStringSelectMenu:()=>kind==='select',isModalSubmit:()=>false,
    async deferReply(){this.deferred=true;},async deferUpdate(){this.deferred=true;},async editReply(payload){this.payload=payload;},
    async reply(payload){this.replied=true;this.payload=payload;}};
}
test('public player buttons render a game detail card after restart and still target a corrected name',async t=>{
  const {store,cards}=fixture(t);store.importGame(game());
  const id=recentComponents(store.getGame(1))[0].components[0].custom_id;
  store.setGameName(ADMIN_ID,'G1','Sputtered','MainAccount');
  const ui=new DiscordUI(store,new RecorderBridge(store,{log:()=>{}}));assert.equal(ui.sessions.size,0);
  const handle=createInteractionHandler({store,ui,cards,log:()=>{}}),press=interaction(USER,null,{},'button',id);
  press.deferUpdate=async()=>assert.fail('Public cards must stay in place');
  await handle(press);assert.match(press.payload.embeds[0].image.url,/matchups-G00001-MainAccount\.png/);
  assert.equal(press.payload.files.length,1);await imageInfo(press.payload.files[0].attachment);
  const picker=press.payload.components.flatMap(r=>r.components).find(c=>c.custom_id.includes(':gameplayer:'));
  assert.ok(picker.options.some(o=>o.value==='Sputtered' && o.label.startsWith('MainAccount')));
});
test('every style renders valid game and player cards, with distinct images and no input mutations',async t=>{
  const {store}=fixture(t);store.importGame(game());const match=store.getGame(1),player=playerStats(store.games(),'Sputtered');
  const before=JSON.stringify({match,player}),images=[];
  for(const style of Object.keys(STYLES)) {
    const profile=await renderPlayerCard(player,{style}),result=await renderGameCard(match,{style});
    assert.deepEqual(await imageInfo(profile),{width:style==='inventory'?1408:style==='studio'?1280:1120,height:style==='inventory'?782:778});
    const dimensions=await imageInfo(result);assert.equal(dimensions.width,style==='inventory'?1408:style==='studio'?1280:1120);assert.ok(dimensions.height>=400);
    images.push(profile.toString('base64'));
  }
  assert.equal(new Set(images).size,4);assert.equal(JSON.stringify({match,player}),before);
});

test('team upgrade times appear in text and refresh cached game cards when only the timing changes',async t=>{
  const {store,ui,cards}=fixture(t),payload=game();
  payload.teamUpgrades={status:'estimated',teams:{red:{protection1:{status:'estimated',bySec:240}},green:{}}};
  store.importGame(payload);
  const text=ui.render(USER,'replay',{replay:'G1'});
  assert.match(text.embeds[0].fields.find(f=>f.name==='Team upgrades · est. acquired by').value,/P1 4:00/);
  const initial=await cards.decorate(text);
  const raw=JSON.parse(store.db.prepare('SELECT payload FROM games WHERE id=1').get().payload);
  raw.teamUpgrades.teams.red.protection1.bySec=300;
  store.db.prepare('UPDATE games SET payload=? WHERE id=1').run(JSON.stringify(raw));
  const changed=await cards.decorate(ui.render(USER,'replay',{replay:'G1'}));
  assert.notDeepEqual(initial.files[0].attachment,changed.files[0].attachment);
  for(const style of Object.keys(STYLES))assert.ok((await imageInfo(await renderGameCard(store.getGame(1),{style}))).height>=400);
});
test('avatars validate names, share in-flight requests, cache failures and successes, and enforce image bounds',async()=>{
  let now=0,calls=0,release;
  const source=createCanvas(8,8).toBuffer('image/png'),waiting=new Promise(resolve=>release=resolve);
  const avatars=new AvatarCache({now:()=>now,fetcher:async(url)=>{calls++;assert.equal(url,'https://mc-heads.net/avatar/Sputtered/128');await waiting;return new Response(source,{headers:{'content-type':'image/png'}});}});
  const a=avatars.get('Sputtered'),b=avatars.get('sputtered');release();assert.equal(await a,await b);assert.equal(calls,1);
  await avatars.get('Sputtered');assert.equal(calls,1);assert.equal(await avatars.get('../../secret'),null);
  now=24*3600_000+1;await avatars.get('Sputtered');assert.equal(calls,2);
  const oversized=Buffer.from(source);oversized.writeUInt32BE(9000,16);
  const invalid=new AvatarCache({now:()=>now,fetcher:async()=>new Response(oversized,{headers:{'content-type':'image/png'}})});
  assert.equal(await invalid.get('Sputtered'),null);
  let errors=0;const failure=new AvatarCache({now:()=>now,fetcher:async()=>{errors++;throw new Error('offline');}});
  assert.equal(await failure.get('Sputtered'),null);await failure.get('Sputtered');assert.equal(errors,1);
  now+=5*60_000+1;await failure.get('Sputtered');assert.equal(errors,2);
  const oversizedBody=new AvatarCache({fetcher:async()=>new Response(Buffer.alloc(256*1024+1),{headers:{'content-type':'image/png'}})});
  assert.equal(await oversizedBody.get('Sputtered'),null);
});
test('avatar timeouts return the generic placeholder path instead of blocking commands',async()=>{
  const avatars=new AvatarCache({timeout:20,fetcher:async(_url,{signal})=>new Promise((_,reject)=>{
    signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});
  })});
  assert.equal(await avatars.get('Sputtered'),null);assert.equal(avatars.pending.size,0);
});
test('unknown results, unknown teams, long names and W/L edge cases remain renderable',async t=>{
  const {store}=fixture(t);store.importGame(game({winner:null,aliceTeam:null,deaths:0}));
  store.setGameName(ADMIN_ID,'G1','Sputtered','LongName_1234567');
  const player=playerStats(store.games(),'LongName_1234567');assert.equal(player.kd,2);assert.equal(player.wins,0);assert.equal(player.losses,0);assert.equal(player.wl,0);
  const first=await renderGameCard(store.getGame(1));assert.equal((await imageInfo(first)).width,1408);
  for(const style of Object.keys(STYLES)) {
    assert.equal((await imageInfo(await renderPlayerCard(player,{style}))).width,style==='inventory'?1408:style==='studio'?1280:1120);
    assert.equal((await imageInfo(await renderPlayerCard({...player,wins:1,wl:1},{style}))).width,style==='inventory'?1408:style==='studio'?1280:1120);
  }
});
test('identity changes refresh card data and avatars without leaking cached controls between users',async t=>{
  const {store,ui}=fixture(t);store.importGame(game());const requested=[];
  const cards=new ImageCards({store,avatars:{many:async names=>{requested.push(names);return new Map();}}});
  const initial=await cards.decorate(ui.render(USER,'replay',{replay:'G1'}));
  store.addNameLink(ADMIN_ID,'Sputtered','MainAccount','nick');
  const changed=await cards.decorate(ui.render(USER,'replay',{replay:'G1'}));
  assert.notDeepEqual(initial.files[0].attachment,changed.files[0].attachment);
  assert.ok(requested.at(-1).includes('MainAccount'));assert.ok(!requested.at(-1).includes('Sputtered'));
  const owner=await cards.decorate(ui.render(ADMIN_ID,'replay',{replay:'G1'}));
  assert.equal(owner.files[0].attachment,changed.files[0].attachment);assert.equal(requested.length,2);
  assert.ok(owner.components.flatMap(row=>row.components).every(control=>control.custom_id.startsWith(`rp:${ADMIN_ID}:`)));
  assert.ok(changed.components.flatMap(row=>row.components).every(control=>control.custom_id.startsWith(`rp:${USER}:`)));
  store.setWinner(ADMIN_ID,'G1','green');
  const reviewed=await cards.decorate(ui.render(USER,'replay',{replay:'G1'}));
  assert.notDeepEqual(changed.files[0].attachment,reviewed.files[0].attachment);
});
test('name conflicts and card failures keep complete text results and correction controls',async t=>{
  const {store,ui,cards}=fixture(t);store.addNameLink(ADMIN_ID,'Sputtered','Mikowa','nick');store.importGame(game());
  const conflict=ui.render(USER,'replay',{replay:'G1'});assert.equal(await cards.decorate(conflict),conflict);assert.equal(conflict.files,undefined);
  store.resetGameName(ADMIN_ID,'G1','Sputtered');
  const text=ui.render(USER,'replay',{replay:'G1'});cards.image=async()=>{throw new Error('renderer unavailable');};
  assert.equal(await cards.decorate(text),text);assert.ok(text.embeds[0].fields.some(field=>field.name.includes('Red')));
});
test('command, refresh, text toggle, and navigation replace attachments while enforcing access',async t=>{
  const {store,ui,cards}=fixture(t);store.importGame(game());const handle=createInteractionHandler({store,ui,cards,log:()=>{}});
  const command=interaction(USER,'stats',{user:'Sputtered'});await handle(command);
  assert.match(command.payload.embeds[0].image.url,/attachment:\/\/stats-Sputtered.png/);assert.equal(command.payload.files.length,1);
  assert.deepEqual(command.payload.attachments,[]);assert.equal(command.payload.cardView,undefined);
  const buttons=command.payload.components.flatMap(row=>row.components),toggle=buttons.find(button=>button.label==='Show text');
  const text=interaction(USER,null,{},'button',toggle.custom_id);await handle(text);
  assert.equal(text.payload.files,undefined);assert.equal(text.payload.embeds[0].image,undefined);
  assert.ok(text.payload.embeds[0].fields.some(field=>field.name==='Kills & deaths'));assert.deepEqual(text.payload.attachments,[]);
  const refresh=interaction(USER,null,{},'button',buttons.find(button=>button.label==='Refresh').custom_id);await handle(refresh);assert.equal(refresh.payload.files.length,1);
  const queue=interaction(USER,null,{},'button',`rp:${USER}:go:queue`);await handle(queue);assert.equal(queue.payload.files,undefined);assert.deepEqual(queue.payload.attachments,[]);
  store.whitelist(ADMIN_ID,USER,false);const blocked=interaction(USER,null,{},'button',toggle.custom_id);await handle(blocked);assert.ok(blocked.payload.embeds[0].fields.some(f=>f.name==='Kills & deaths'));
});
test('completion DMs include the game card and keep the submitter’s result buttons',async t=>{
  const {store,cards}=fixture(t);const job=store.submit(USER,'finished');store.claimNext();store.complete(job.id,game());
  const sent=[];const notifier=new CompletionNotifier({store,cards,send:async(user,payload)=>sent.push({user,payload})});
  await notifier.tick();assert.equal(sent.length,1);assert.equal(sent[0].user,USER);
  assert.equal(sent[0].payload.files.length,1);assert.match(sent[0].payload.embeds[0].image.url,/game-G00001/);
  assert.ok(sent[0].payload.components[0].components.some(control=>control.label==='View results'));
  assert.ok(sent[0].payload.components[0].components.some(control=>control.label==='Show text'));
  assert.equal(store.completionDM(job.id).status,'sent');await notifier.stop();
});
test('styles can be mixed or disabled without changing score data',async t=>{
  const {store,ui}=fixture(t);store.importGame(game());
  const cards=new ImageCards({store,playerStyle:'studio',gameStyle:'off',avatars:offlineAvatars});
  const score=ui.render(USER,'replay',{replay:'G1'});assert.equal(await cards.decorate(score),score);
  assert.equal((await cards.decorate(ui.render(USER,'stats',{user:'Sputtered'}))).files.length,1);
  assert.throws(()=>new ImageCards({store,style:'missing'}),/Unknown card style/);
});
test('game matchup cards, player selection, text mode and red Back restore the previous panels',async t=>{
  const {store,ui,cards}=fixture(t);store.importGame(game());
  const handle=createInteractionHandler({store,ui,cards,log:()=>{}});
  const controls=payload=>payload.components.flatMap(row=>row.components);
  async function press(payload,label) {
    const control=controls(payload).find(c=>c.label===label);assert.ok(control,`Missing ${label}`);
    const next=interaction(USER,null,{},'button',control.custom_id);next.message=payload;await handle(next);return next.payload;
  }
  const library=interaction(USER,'recentgames');await handle(library);
  const open=interaction(USER,null,{},'select',controls(library.payload).find(c=>c.custom_id.includes(':open:')).custom_id);
  open.values=['G00001'];open.message=library.payload;await handle(open);
  const matchups=await press(open.payload,'Game matchups');
  assert.match(matchups.embeds[0].image.url,/matchups-G00001-Sputtered/);
  assert.equal(controls(matchups).find(c=>c.label==='Back').style,4);
  assert.match(matchups.embeds[0].description,/this game/);
  for (const row of matchups.components) {assert.ok(row.components.length<=5);for(const c of row.components)assert.ok(c.custom_id.length<=100);}
  assert.ok(matchups.components.length<=5);
  const text=await press(matchups,'Show text');assert.equal(text.files,undefined);
  assert.match(text.embeds[0].fields.find(f=>f.name==='vs Mikowa').value,/2 kills · 1 deaths · — assists · \*\*2.00 K\/D/);
  const refreshed=await press(text,'Refresh');assert.equal(refreshed.files,undefined);
  const backToCard=await press(refreshed,'Back');assert.match(backToCard.embeds[0].image.url,/matchups-G00001-Sputtered/);
  const select=interaction(USER,null,{},'select',controls(matchups).find(c=>c.custom_id.includes(':gameplayer:')).custom_id);
  select.values=['Mikowa'];select.message=matchups;await handle(select);
  assert.match(select.payload.embeds[0].image.url,/matchups-G00001-Mikowa/);
  const previousPlayer=await press(select.payload,'Back');assert.match(previousPlayer.embeds[0].image.url,/matchups-G00001-Sputtered/);
  const backToGame=await press(previousPlayer,'Back');assert.match(backToGame.embeds[0].image.url,/game-G00001/);
  const backToLibrary=await press(backToGame,'Back');assert.equal(backToLibrary.embeds[0].title,'Recent games');assert.equal(backToLibrary.files,undefined);
  assert.deepEqual(backToLibrary.attachments,[]);
});
test('game matchup refresh follows a renamed player and red Back enforces owner and expiry',async t=>{
  const {store,ui,cards}=fixture(t);store.importGame(game());const handle=createInteractionHandler({store,ui,cards,log:()=>{}});
  const first=interaction(USER,null,{},'button',`rp:${USER}:gamematchups:G1`);await handle(first);
  const all=payload=>payload.components.flatMap(row=>row.components);
  const refresh=all(first.payload).find(c=>c.label==='Refresh');
  store.addNameLink(ADMIN_ID,'Sputtered','MainAccount','nick');
  const updated=interaction(USER,null,{},'button',refresh.custom_id);updated.message=first.payload;await handle(updated);
  assert.match(updated.payload.embeds[0].image.url,/MainAccount/);
  const ownerPage=ui.render(ADMIN_ID,'admin'),ownerToken=ui.panelToken(ADMIN_ID,ownerPage);
  const forged=interaction(USER,null,{},'button',`rp:${USER}:back:${ownerToken}`);await handle(forged);assert.match(forged.payload.content,/someone else/);
  const back=all(first.payload).find(c=>c.label==='Back'),token=back.custom_id.split(':')[3];
  ui.getSession(USER,token).expires=0;
  const expired=interaction(USER,null,{},'button',back.custom_id);await handle(expired);assert.match(expired.payload.content,/expired/);
});

test('leaderboard cards support metric switching, text, refresh and red Back with finite ratios',async t=>{
  const {store,ui,cards}=fixture(t);store.importGame(game({kills:1,deaths:0}));store.submit(USER,'submission');
  const handle=createInteractionHandler({store,ui,cards,log:()=>{}}),controls=p=>p.components.flatMap(r=>r.components);
  const command=interaction(USER,'leaderboard');await handle(command);
  const initial=command.payload;assert.match(initial.embeds[0].image.url,/leaderboard-kd.png/);
  assert.deepEqual(await imageInfo(initial.files[0].attachment),{width:1120,height:720});
  const showText=interaction(USER,null,{},'button',controls(initial).find(c=>c.label==='Show text').custom_id);
  showText.message=initial;await handle(showText);
  assert.equal(showText.payload.files,undefined);assert.equal(showText.payload.embeds[0].image,undefined);
  assert.match(showText.payload.embeds[0].description,/1.00/);assert.doesNotMatch(showText.payload.embeds[0].description,/∞|Infinity/);
  const refresh=interaction(USER,null,{},'button',controls(showText.payload).find(c=>c.label==='Refresh').custom_id);
  refresh.message=showText.payload;await handle(refresh);assert.equal(refresh.payload.files,undefined);
  const backControl=controls(refresh.payload).find(c=>c.label==='Back');assert.equal(backControl.style,4);
  const back=interaction(USER,null,{},'button',backControl.custom_id);back.message=refresh.payload;await handle(back);
  assert.match(back.payload.embeds[0].image.url,/leaderboard-kd.png/);
  let previous=initial;
  for(const metric of ['wl','submissions']) {
    const menu=controls(previous).find(c=>c.custom_id.includes(':ranking:'));
    const select=interaction(USER,null,{},'select',menu.custom_id);select.message=previous;select.values=[metric];await handle(select);
    assert.match(select.payload.embeds[0].image.url,new RegExp(`leaderboard-${metric}.png`));
    assert.deepEqual(select.payload.attachments,[]);assert.equal(select.payload.files.length,1);
    assert.equal(controls(select.payload).find(c=>c.label==='Back').style,4);
    assert.ok(select.payload.components.length<=5);previous=select.payload;
  }
  const token=ui.panelToken(USER,initial);
  const forged=interaction(ADMIN_ID,null,{},'button',`rp:${ADMIN_ID}:textranking:${token}`);await handle(forged);
  assert.match(forged.payload.content,/someone else/);
  store.whitelist(ADMIN_ID,USER,false);
  const revoked=interaction(USER,null,{},'button',`rp:${USER}:textranking:${token}`);await handle(revoked);assert.ok(revoked.payload.embeds[0]);
});
test('leaderboard snapshots refresh after name fixes and invalid submissions; user names never become Minecraft avatar requests',async t=>{
  const {store,ui}=fixture(t);store.importGame(game());const requested=[];
  const cards=new ImageCards({store,avatars:{many:async names=>{requested.push(names);return new Map();}},submitterName:async()=> 'My Discord Name'});
  const first=await cards.decorate(ui.render(USER,'leaderboard'));
  assert.ok(requested[0].includes('Sputtered'));
  store.addNameLink(ADMIN_ID,'Sputtered','MainAccount','nick');
  const renamed=await cards.decorate(ui.render(USER,'leaderboard'));
  assert.notDeepEqual(first.files[0].attachment,renamed.files[0].attachment);assert.ok(requested.at(-1).includes('MainAccount'));
  const job=store.submit(USER,'missing');
  const submissions=await cards.decorate(ui.render(USER,'leaderboard',{metric:'submissions'}));
  assert.deepEqual(requested.at(-1),[]);
  store.claimNext();store.invalidate(job.id);
  const invalid=await cards.decorate(ui.render(USER,'leaderboard',{metric:'submissions'}));
  assert.notDeepEqual(submissions.files[0].attachment,invalid.files[0].attachment);
  const namesFail=new ImageCards({store,avatars:offlineAvatars,submitterName:async()=>{throw new Error('missing user');}});
  store.submit(USER,'another');assert.equal((await namesFail.decorate(ui.render(USER,'leaderboard',{metric:'submissions'}))).files.length,1);
});
test('leaderboard cards keep text on render failure or disabled cards and preserve conflict warnings',async t=>{
  const {store,ui,cards}=fixture(t);store.addNameLink(ADMIN_ID,'Sputtered','Mikowa','nick');store.importGame(game());
  const page=ui.render(USER,'leaderboard');
  const rendered=await cards.decorate(page);assert.ok(rendered.embeds[0].fields.some(f=>f.name==='Names to check'));assert.equal(rendered.files.length,1);
  cards.image=async()=>{throw new Error('failed renderer');};assert.equal(await cards.decorate(page),page);
  const off=new ImageCards({store,style:'off',avatars:offlineAvatars});assert.equal(await off.decorate(page),page);
});

test('owner can void and restore from the game card; other users see the label without owner controls',async t=>{
  const {store,ui,cards}=fixture(t);store.importGame(game());
  const handle=createInteractionHandler({store,ui,cards,log:()=>{}}),controls=p=>p.components.flatMap(r=>r.components);
  const original=interaction(ADMIN_ID,'replay',{replay:'G1'});await handle(original);
  const control=controls(original.payload).find(c=>c.label==='Void game');assert.equal(control.style,4);
  const forged=interaction(USER,null,{},'button',`rp:${USER}:void:G1`);await handle(forged);assert.match(forged.payload.content,/just for me/);
  const voided=interaction(ADMIN_ID,null,{},'button',control.custom_id);voided.message=original.payload;await handle(voided);
  assert.equal(store.getGame(1).voided,true);assert.match(voided.payload.embeds[0].description,/Game voided/);
  assert.ok(voided.payload.embeds[0].fields.some(f=>f.name==='Game voided'));
  assert.notDeepEqual(voided.payload.files[0].attachment,original.payload.files[0].attachment);
  assert.equal(controls(voided.payload).find(c=>c.label==='Game matchups').disabled,true);
  for(const row of voided.payload.components)assert.ok(row.components.length<=5);assert.ok(voided.payload.components.length<=5);
  const publicPage=await cards.decorate(ui.render(USER,'replay',{replay:'G1'}));
  assert.ok(!controls(publicPage).some(c=>['Void game','Restore game'].includes(c.label)));
  assert.equal(ui.render(USER,'stats',{user:'Sputtered'}).cardView.kind,'player');
  assert.equal(playerStats(store.games(),'Sputtered').games,0);
  assert.match(ui.render(USER,'recentgames').embeds[0].description,/Voided/);
  assert.ok(!ui.render(USER,'leaderboard').embeds[0].fields.some(f=>f.name==='Names to check'));
  const restore=interaction(ADMIN_ID,null,{},'button',controls(voided.payload).find(c=>c.label==='Restore game').custom_id);
  restore.message=voided.payload;await handle(restore);assert.equal(store.getGame(1).voided,false);
  assert.deepEqual(restore.payload.files[0].attachment,original.payload.files[0].attachment);
  const command=interaction(ADMIN_ID,'void',{replay:'G1',reason:'Wrong match'});await handle(command);
  assert.equal(store.getGame(1).void_reason,'Wrong match');
  const unvoid=interaction(ADMIN_ID,'unvoid',{replay:'G1'});await handle(unvoid);assert.equal(store.getGame(1).voided,false);
});
