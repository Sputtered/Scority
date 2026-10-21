import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ReplayStore,ADMIN_ID,dayKey,nextReset,replayId} from '../lib/discord/store.js';
import {game} from './fixtures/discord-game.js';
const USER='111111111111111111', OTHER='222222222222222222';
test('unlimited grants persist, preserve usage and duplicate guards, and revoke immediately',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nolimit-')),file=path.join(dir,'store.sqlite');
  let s=new ReplayStore(file);
  try {
    assert.throws(()=>s.setNoLimit(USER,USER),/just for me/);
    s.setNoLimit(ADMIN_ID,USER);
    for(let i=0;i<7;i++)s.submit(USER,`unlimited${i}`);
    assert.equal(s.quota(USER).used,7);assert.equal(s.quota(USER).unlimited,true);
    assert.throws(()=>s.submit(USER,'unlimited0'),/already/);assert.equal(s.quota(USER).used,7);
    s.close();s=new ReplayStore(file);assert.equal(s.hasNoLimit(USER),true);
    assert.equal(s.quota(OTHER).remaining,5);assert.equal(s.hasPriority(USER),false);
    s.setNoLimit(ADMIN_ID,USER,false);assert.equal(s.quota(USER).remaining,0);
    assert.throws(()=>s.submit(USER,'revoked'),/5 replay spots/);
    assert.deepEqual(s.audit().filter(a=>a.action==='nolimit').map(a=>JSON.parse(a.detail).enabled),[false,true]);
  } finally {s.close();fs.rmSync(dir,{recursive:true,force:true});}
});
function make(t,options) { const store=new ReplayStore(':memory:',options); t.after(()=>store.close()); return store; }

test('load retry budget survives a restart and manual retry resets it without charging quota',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scority-load-retry-')),file=path.join(dir,'store.sqlite');
  let store=new ReplayStore(file);
  try{
    const job=store.submit(USER,'slow-replay');store.claimNext();
    assert.equal(store.requeueLoadTimeout(job.id,'HUD missing',1),1);
    store.claimNext();store.close();store=new ReplayStore(file);
    assert.equal(store.recover(),1);const recovered=store.claimNext();
    assert.equal(recovered.load_retries,1);assert.equal(store.requeueLoadTimeout(job.id,'Still missing',1),0);
    store.fail(job.id,'Still missing');store.retry(ADMIN_ID,`R${job.id}`);store.claimNext();
    assert.equal(store.requeueLoadTimeout(job.id,'HUD missing',1),1);
    assert.equal(store.quota(USER).used,1);
  }finally{
    store.close();if(path.dirname(dir)===path.resolve(os.tmpdir()))fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('access is public but priority and quota resets remain owner-only',t=>{
  const s=make(t);
  assert.equal(s.submit(USER,'abc').status,'queued');
  assert.throws(()=>s.setPriority(USER,USER),/just for me/);
  assert.throws(()=>s.resetLimit(USER,USER),/just for me/);
  assert.equal(s.allowed(ADMIN_ID),true);
  s.whitelist(ADMIN_ID,USER);
  s.whitelist(ADMIN_ID,USER,false);
  assert.equal(s.findJob('abc').status,'queued');
  assert.equal(s.submit(USER,'def').status,'queued');
  assert.throws(()=>s.submit('invalid','bad'),/valid Discord/);
});
test('quota is atomic, duplicate-safe, and independent for each user',t=>{
  const s=make(t); for(const u of [USER,OTHER]) s.whitelist(ADMIN_ID,u);
  const j=s.submit(USER,'/replay ABC');
  assert.throws(()=>s.submit(USER,'abc'),/already/);
  assert.equal(s.quota(USER).used,1);
  s.cancel(USER,`R${j.id}`); assert.equal(s.quota(USER).used,1);
  assert.throws(()=>s.cancel(OTHER,'ABC'),/own/);
  for(const id of ['def','ghi','four','five'])s.submit(USER,id);
  assert.throws(()=>s.submit(USER,'jkl'),/5 replay spots/);
  assert.equal(s.quota(OTHER).remaining,5);
  s.resetLimit(ADMIN_ID,USER); assert.equal(s.quota(USER).remaining,5);
  assert.equal(s.submit(USER,'jkl').status,'queued');
});
test('Pacific reset follows calendar midnight in summer, winter, and DST changes',t=>{
  let time=new Date('2026-09-05T06:59:59Z'); const s=make(t,{now:()=>time});
  s.whitelist(ADMIN_ID,USER); s.submit(USER,'a');
  assert.equal(dayKey(time),'2026-09-04');
  assert.equal(nextReset(time),Date.parse('2026-09-05T07:00:00Z')/1000);
  time=new Date('2026-09-05T07:00:00Z'); assert.equal(s.quota(USER).remaining,5);
  assert.equal(nextReset(new Date('2026-03-08T08:00:00Z')),Date.parse('2026-03-09T07:00:00Z')/1000);
  assert.equal(nextReset(new Date('2026-11-01T07:00:00Z')),Date.parse('2026-11-02T08:00:00Z')/1000);
});

test('priority promotes waiting jobs immediately, preserves FIFO per tier, and never preempts recording',t=>{
  const s=make(t),active=s.submit(USER,'active'),normal=s.submit(USER,'normal');
  assert.equal(s.claimNext().id,active.id);
  const fast1=s.submit(OTHER,'fast1'),fast2=s.submit(OTHER,'fast2');
  assert.throws(()=>s.setPriority(USER,OTHER),/just for me/);
  s.setPriority(ADMIN_ID,OTHER);
  assert.deepEqual(s.queue().map(j=>j.id),[active.id,fast1.id,fast2.id,normal.id]);
  assert.equal(s.claimNext(),null);assert.equal(s.position(normal.id),4);
  s.setPriority(ADMIN_ID,OTHER,false);
  assert.deepEqual(s.queue().map(j=>j.id),[active.id,normal.id,fast1.id,fast2.id]);
  s.setPriority(ADMIN_ID,OTHER);s.fail(active.id,'test');assert.equal(s.claimNext().id,fast1.id);
  assert.deepEqual(s.audit().filter(e=>e.action==='priority').map(e=>JSON.parse(e.detail).enabled),[true,false,true]);
});

test('priority survives reopening and everyone including owner has five daily submissions',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'priority-store-')),file=path.join(dir,'store.sqlite');
  let s=new ReplayStore(file);t.after(()=>{if(s.db.isOpen)s.close();fs.rmSync(dir,{recursive:true,force:true});});
  s.setPriority(ADMIN_ID,USER);s.close();s=new ReplayStore(file);
  assert.equal(s.hasPriority(USER),true);
  for(const user of [USER,OTHER,ADMIN_ID]){
    for(let i=0;i<5;i++)s.submit(user,`${user}-${i}`);
    assert.throws(()=>s.submit(user,`${user}-six`),/5 replay spots/);
    assert.equal(s.quota(user).remaining,0);
  }
});
test('queue pauses, claims one job, recovers and survives reopen',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-store-'));
  const file=path.join(dir,'test.sqlite'); let s=new ReplayStore(file);
  t.after(()=>{if(s.db.isOpen)s.close();fs.rmSync(dir,{recursive:true,force:true});});
  s.whitelist(ADMIN_ID,USER); const first=s.submit(USER,'a'), second=s.submit(USER,'b');
  s.pause(ADMIN_ID,true); assert.equal(s.claimNext(),null);
  s.pause(ADMIN_ID,false); assert.equal(s.claimNext().id,first.id); assert.equal(s.claimNext(),null);
  assert.equal(s.position(second.id),2); s.close();
  s=new ReplayStore(file);
  assert.equal(s.recover(),1); assert.equal(s.claimNext().id,first.id);
  assert.equal(s.quota(USER).used,2);
  s.fail(first.id,'disconnect'); s.retry(ADMIN_ID,'a');
  assert.equal(s.claimNext().id,second.id); assert.equal(s.quota(USER).used,2);
});
test('completed recordings are indexed once and owner corrections are audited',t=>{
  const s=make(t); s.whitelist(ADMIN_ID,USER); s.submit(USER,'abc'); const j=s.claimNext();
  const g=s.complete(j.id,game());
  assert.equal(s.findJob('abc').status,'completed'); assert.equal(s.findGame('abc').id,g.id);
  s.importGame(game()); assert.equal(s.games().length,1);
  assert.throws(()=>s.submit(USER,'abc'),/already/);
  assert.throws(()=>s.setWinner(USER,'abc','green'),/just for me/);
  s.setWinner(ADMIN_ID,'abc','green','Checked replay');
  assert.equal(s.findGame('abc').payload.match.winner,'green');
  assert.equal(s.audit()[0].action,'setwinner');
  s.setWinner(ADMIN_ID,'abc','unknown'); assert.equal(s.findGame('abc').payload.match.winner,null);
});
test('invalid replay commands and empty games never enter scoring',t=>{
  for(const value of ['/lobby','abc\n/replay xyz','../../file','a b','']) assert.throws(()=>replayId(value));
  const s=make(t); assert.throws(()=>s.importGame({match:{},players:{},killFeed:[],bedBreaks:[]}),/no game to score/);
});
test('copied replay time markers are stripped before storage and duplicate checks',t=>{
  const id='8dcb02bb-6e61-4c0f-a435-40e1712f4661';
  for (const input of [`/replay ${id} #14cb857e`,`${id}#14cb857e`,`  /REPLAY ${id}\t#14CB857E  `,id]) {
    assert.equal(replayId(input),id);
  }
  const s=make(t);s.whitelist(ADMIN_ID,USER);
  const job=s.submit(USER,`/replay ${id} #14cb857e`);
  assert.equal(job.replay_id,id);
  assert.throws(()=>s.submit(USER,`${id} #abcd`),/already/);
  assert.throws(()=>s.submit(USER,id),/already/);
  assert.equal(s.quota(USER).used,1);
  for (const input of [`${id} #`,`${id} #not-hex`,`${id} #abc extra`,`${id}\n#abc`,`${id} #abc\n/lobby`]) {
    assert.throws(()=>replayId(input));
  }
});

test('submission rankings exclude missing replay IDs and never double-count retries or quota resets',t=>{
  const s=make(t);s.whitelist(ADMIN_ID,USER);
  const invalid=s.submit(USER,'missing'),good=s.submit(USER,'good');s.submit(ADMIN_ID,'admin-replay');
  assert.equal(s.submissionLeaderboard()[0].submissions,2);
  s.claimNext();assert.equal(s.invalidate(invalid.id),true);
  assert.equal(s.submissionLeaderboard().find(p=>p.user_id===USER).submissions,1);
  s.claimNext();s.fail(good.id,'Disconnected');s.retry(ADMIN_ID,'good');s.resetLimit(ADMIN_ID,USER);
  assert.throws(()=>s.submit(USER,'good'),/already/);
  assert.equal(s.submissionLeaderboard().find(p=>p.user_id===USER).submissions,1);
  s.cancel(USER,'good');assert.equal(s.submissionLeaderboard().find(p=>p.user_id===USER).submissions,1);
  assert.equal(s.getJob(invalid.id).game_id,null);assert.equal(s.games().length,0);
  assert.throws(()=>s.retry(ADMIN_ID,'missing'),/failed or was cancelled/);
});

test('scoring and imports enforce 180 seconds, including unknown lengths, without partial games',t=>{
  const s=make(t);
  for(const [i,seconds] of [179,179.99,null,undefined,0,-1,'180',180,181].entries()) {
    s.resetLimit(ADMIN_ID,ADMIN_ID);const job=s.submit(ADMIN_ID,`length-${i}`);s.claimNext();
    const payload=game({index:i+1});payload.match.totalDurationSec=seconds;
    if(typeof seconds==='number' && seconds>=180) {
      assert.ok(s.complete(job.id,payload));assert.equal(s.getJob(job.id).status,'completed');
    } else {
      assert.equal(s.complete(job.id,payload),null);assert.equal(s.getJob(job.id).status,'invalid');
      assert.equal(s.getJob(job.id).game_id,null);assert.match(s.getJob(job.id).error,/180 seconds/);
      assert.equal(s.completionDM(job.id).status,'pending');assert.throws(()=>s.importGame(payload),/180 seconds/);
    }
  }
  assert.equal(s.games().length,2);assert.equal(s.queue().length,0);
});
test('voiding preserves raw data, persists after restart, and can be restored with an audit trail',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'void-games-'));
  const file=path.join(dir,'replays.sqlite');let s=new ReplayStore(file);
  t.after(()=>{if(s.db.isOpen)s.close();fs.rmSync(dir,{recursive:true,force:true});});
  const job=s.submit(ADMIN_ID,'voidable');s.claimNext();s.complete(job.id,game());
  const raw=s.db.prepare('SELECT payload FROM games WHERE id=1').get().payload;
  assert.throws(()=>s.setVoided(USER,'G1',true),/just for me/);
  s.setVoided(ADMIN_ID,'voidable',true,'Wrong match');assert.equal(s.submissionLeaderboard().length,0);
  assert.equal(s.getGame(1).payload.match.voided,true);assert.equal(s.getGame(1).void_reason,'Wrong match');
  assert.equal(s.importGame(game()),1);assert.equal(s.getGame(1).voided,true);
  s.close();s=new ReplayStore(file);
  assert.equal(s.getGame(1).voided,true);assert.equal(s.db.prepare('SELECT payload FROM games WHERE id=1').get().payload,raw);
  assert.throws(()=>s.setVoided(ADMIN_ID,'G1',true),/already voided/);
  s.setVoided(ADMIN_ID,'R1',false);assert.equal(s.getGame(1).voided,false);assert.equal(s.submissionLeaderboard()[0].submissions,1);
  assert.deepEqual(s.audit().filter(a=>['void','unvoid'].includes(a.action)).map(a=>a.action),['unvoid','void']);
  assert.equal(s.getJob(job.id).game_id,1);assert.equal(s.games().length,1);
});
