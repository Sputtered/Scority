import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ReplayStore,ADMIN_ID} from '../lib/discord/store.js';
import {RecorderBridge} from '../lib/discord/recorder.js';
import {CompletionNotifier} from '../lib/discord/notifications.js';
import {DiscordUI} from '../lib/discord/ui.js';
import {ImageCards} from '../lib/discord/cards/service.js';
import {createInteractionHandler} from '../lib/discord/interactions.js';
import {playerStats} from '../lib/discord/stats.js';
import {game} from './fixtures/discord-game.js';
const USER='111111111111111111';
function fixture(t){
  const s=new ReplayStore(':memory:');t.after(()=>s.close());
  const job=s.submit(USER,'saved-replay');s.claimNext();const saved=s.complete(job.id,game());
  return {s,job,saved};
}
const raw=s=>s.db.prepare('SELECT payload FROM games WHERE id=1').get().payload;

test('rescore replaces in place, keeps corrections and chronology, and never adds quota or leaderboard credit',t=>{
  const {s,job,saved}=fixture(t),original=raw(s),initialQuota=s.quota(USER).used;
  s.setGameName(ADMIN_ID,'G1','Sputtered','MainName');
  assert.throws(()=>s.rescore(USER,'G1'),/just for me/);
  assert.equal(s.rescore(ADMIN_ID,'G1').id,job.id);
  assert.equal(raw(s),original);assert.equal(s.getGame(1).payload.players.MainName.kills,2);
  for(const ref of ['G1','R1','saved-replay'])assert.throws(()=>s.rescore(ADMIN_ID,ref),/already queued/);
  s.claimNext();s.setWinner(ADMIN_ID,'G1','green','Checked');s.setVoided(ADMIN_ID,'G1',true,'Review');
  const payload=game({kills:4});payload.players.Sputtered.diamondsCollected=12;
  payload.teamUpgrades={teams:{red:{protection1:{status:'estimated',bySec:200}}}};
  const updated=s.complete(job.id,payload);
  assert.equal(updated.id,saved.id);assert.equal(updated.recorded_at,saved.recorded_at);
  assert.equal(updated.payload.players.MainName.kills,4);assert.equal(updated.payload.players.MainName.diamondsCollected,12);
  assert.equal(updated.payload.teamUpgrades.teams.red.protection1.bySec,200);
  assert.equal(updated.payload.match.winner,'green');assert.equal(updated.voided,true);assert.equal(updated.void_reason,'Review');
  assert.equal(s.games().length,1);assert.equal(s.jobs().length,1);assert.equal(s.quota(USER).used,initialQuota);assert.equal(s.quota(ADMIN_ID).used,0);
  const revision=s.db.prepare('SELECT * FROM game_revisions').get();assert.equal(revision.payload,original);
  assert.equal(s.nextCompletionDM().user_id,ADMIN_ID);assert.equal(s.nextCompletionDM().rescore_requested_by,ADMIN_ID);
  s.setVoided(ADMIN_ID,'G1',false);assert.equal(playerStats(s.games(),'MainName').games,1);assert.equal(playerStats(s.games(),'MainName').kills,4);
  assert.equal(s.submissionLeaderboard()[0].submissions,1);assert.equal(s.submissionLeaderboard()[0].user_id,USER);
  assert.ok(s.audit().some(a=>a.action==='rescored'));
  s.rescore(ADMIN_ID,'R1');s.claimNext();payload.players.Sputtered.diamondsCollected=15;s.complete(job.id,payload);
  assert.equal(s.getGame(1).payload.players.MainName.diamondsCollected,15);assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM game_revisions').get().n,2);
});

test('failed, expired, short or cancelled rescoring leaves the saved game and its submission credit intact',t=>{
  const {s,job}=fixture(t),original=raw(s);
  for(const mode of ['failed','invalid','short','cancelled']){
    s.rescore(ADMIN_ID,'G1');
    if(mode==='cancelled')s.cancel(ADMIN_ID,'R1');
    else{
      s.claimNext();
      if(mode==='failed')s.fail(job.id,'Disconnected');
      if(mode==='invalid')s.invalidate(job.id);
      if(mode==='short'){const p=game();p.match.totalDurationSec=179;assert.equal(s.complete(job.id,p),null);}
    }
    assert.equal(raw(s),original);assert.equal(s.findGame('R1').id,1);assert.equal(s.games().length,1);
    assert.equal(s.submissionLeaderboard()[0].submissions,1);assert.equal(s.quota(USER).used,1);
  }
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM game_revisions').get().n,0);
  s.retry(ADMIN_ID,'R1');assert.equal(s.nextCompletionDM(),undefined);
  assert.equal(s.claimNext().rescore_requested_by,ADMIN_ID);
  s.complete(job.id,game({kills:3}));assert.equal(s.getGame(1).payload.players.Sputtered.kills,3);
});

test('invalid replacements fail atomically through the recorder, retaining old results',t=>{
  const {s,job}=fixture(t),original=raw(s);s.setGameName(ADMIN_ID,'G1','Sputtered','MainName');
  const second=game({index:2});s.importGame(second);
  const cases=[
    {...game(),players:{}},
    {...game(),match:{...game().match,endReason:'disconnect'}},
    {...game(),match:{...game().match,replayId:'wrong-replay'}},
    {...game(),tracking:{status:'invalid'}},
    {...game(),players:{Mikowa:game().players.Mikowa},killFeed:[{t:1,killer:'Mikowa',victim:'SomeoneElse'}],awards:{},bedBreaks:[]},
    second,
  ];
  for(const payload of cases){
    s.rescore(ADMIN_ID,'G1');const bridge=new RecorderBridge(s,{log:()=>{}});bridge.activeJob=s.claimNext();
    assert.equal(bridge.complete(payload),null);assert.equal(s.getJob(job.id).status,'failed');
    assert.equal(raw(s),original);assert.equal(s.games().length,2);
  }
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM game_revisions').get().n,0);
});

test('imported games can be rescored without creating a counted submission; missing replay IDs fail clearly',t=>{
  const s=new ReplayStore(':memory:');t.after(()=>s.close());
  const p=game();p.match.replayId='imported-replay';s.importGame(p);
  const job=s.rescore(ADMIN_ID,'G1');assert.equal(job.submission_credit,0);assert.equal(s.quota(ADMIN_ID).used,0);
  assert.equal(s.submissionLeaderboard().length,0);s.claimNext();s.complete(job.id,p);
  assert.equal(s.games().length,1);assert.equal(s.submissionLeaderboard().length,0);
  s.importGame(game({index:2}));assert.throws(()=>s.rescore(ADMIN_ID,'G2'),/no replay ID/);
  assert.throws(()=>s.rescore(ADMIN_ID,'missing'),/saved game/);
});

test('old database schema migrates idempotently and an interrupted rescore recovers after restart',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rescore-')),file=path.join(dir,'db.sqlite');
  const old=new DatabaseSync(file);
  old.exec(`CREATE TABLE jobs (id INTEGER PRIMARY KEY,replay_id TEXT COLLATE NOCASE NOT NULL UNIQUE,user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',submitted_at TEXT NOT NULL,queued_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,game_id INTEGER REFERENCES games(id));
    CREATE TABLE completion_dms(job_id INTEGER PRIMARY KEY REFERENCES jobs(id),status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,next_at TEXT NOT NULL,sent_at TEXT,error TEXT);`);old.close();
  let s=new ReplayStore(file);t.after(()=>{if(s.db.isOpen)s.close();fs.rmSync(dir,{recursive:true,force:true});});
  const job=s.submit(USER,'persisted');s.claimNext();s.complete(job.id,game());s.markDMSent(job.id);
  s.rescore(ADMIN_ID,'G1');s.claimNext();s.close();s=new ReplayStore(file);
  assert.equal(s.recover(),1);assert.equal(s.claimNext().rescore_requested_by,ADMIN_ID);
  assert.equal(s.getGame(1).payload.players.Sputtered.kills,2);
  s.complete(job.id,game({kills:3}));assert.equal(s.getGame(1).payload.players.Sputtered.kills,3);
  assert.equal(s.quota(USER).used,1);assert.equal(s.nextCompletionDM().generation,1);
});

test('rescore completion has a fresh DM nonce and stale delivery cannot acknowledge a newer result',async t=>{
  const {s,job}=fixture(t),sent=[];let release;
  const notifier=new CompletionNotifier({store:s,send:async(user,payload)=>{sent.push({user,payload});if(sent.length===1)await new Promise(resolve=>release=resolve);}});
  const first=notifier.tick();
  s.rescore(ADMIN_ID,'G1');s.claimNext();s.complete(job.id,game({kills:3}));
  release();await first;assert.equal(s.completionDM(job.id).status,'pending');
  await notifier.tick();assert.equal(sent.length,2);assert.equal(sent[1].user,ADMIN_ID);
  assert.notEqual(sent[0].payload.nonce,sent[1].payload.nonce);assert.equal(sent[1].payload.embeds[0].title,'Rescore complete');
  assert.equal(s.completionDM(job.id).status,'sent');
  s.rescore(ADMIN_ID,'G1');s.claimNext();s.fail(job.id,'Replay expired');await notifier.tick();
  assert.equal(sent[2].user,ADMIN_ID);assert.equal(sent[2].payload.embeds[0].title,'Rescore could not finish');
  assert.match(sent[2].payload.embeds[0].description,/previous results.*No daily submission/s);
});

function interaction(user,command,args={},customId=''){
  return {user:{id:user},commandName:command,customId,options:{data:Object.entries(args).map(([name,value])=>({name,value}))},
    isChatInputCommand:()=>Boolean(command),isAutocomplete:()=>false,isButton:()=>Boolean(customId),isStringSelectMenu:()=>false,isModalSubmit:()=>false,
    async deferReply(){this.deferred=true;},async deferUpdate(){this.deferred=true;},async editReply(p){this.payload=p;},async reply(p){this.payload=p;}};
}
test('owner command and game button queue rescoring with visible status and working image/text controls',async t=>{
  const {s}=fixture(t),ui=new DiscordUI(s,new RecorderBridge(s)),cards=new ImageCards({store:s,avatars:{many:async()=>new Map()}});
  const handle=createInteractionHandler({store:s,ui,cards,log:()=>{}});
  const initial=await cards.decorate(ui.render(ADMIN_ID,'replay',{replay:'G1'}));
  const controls=initial.components.flatMap(r=>r.components);
  assert.ok(controls.some(c=>c.label==='Rescore game'));assert.ok(controls.some(c=>c.label==='Show text'));
  for(const c of [interaction(USER,'rescore',{replay:'G1'}),interaction(USER,null,{},`rp:${USER}:rescore:G1`)]){
    await handle(c);assert.match(c.payload.content,/just for me/);
  }
  assert.ok(!ui.render(USER,'replay',{replay:'G1'}).components.flatMap(r=>r.components).some(c=>c.label==='Rescore game'));
  const click=interaction(ADMIN_ID,null,{},controls.find(c=>c.label==='Rescore game').custom_id);click.message=initial;await handle(click);
  assert.match(click.payload.embeds[0].fields.find(f=>f.name==='Rescore').value,/Queued at.*#1/);
  assert.ok(click.payload.components.length<=5);assert.ok(click.payload.components.every(r=>r.components.length<=5));
  assert.ok(click.payload.components.flatMap(r=>r.components).some(c=>c.label==='Show text'));
  s.cancel(ADMIN_ID,'R1');const command=interaction(ADMIN_ID,'rescore',{replay:'saved-replay'});await handle(command);
  assert.equal(s.getJob(1).status,'queued');
});
