import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ReplayStore, ADMIN_ID } from '../lib/discord/store.js';
import { CompletionNotifier } from '../lib/discord/notifications.js';
import { RecorderBridge } from '../lib/discord/recorder.js';
import { YELLOW } from '../lib/discord/theme.js';
import { game } from './fixtures/discord-game.js';
const USER='111111111111111111';
function setup(t,options={}) {
  const store=new ReplayStore(':memory:',options);t.after(()=>store.close());store.whitelist(ADMIN_ID,USER);
  const job=store.submit(USER,'my-replay');store.claimNext();
  return {store,job};
}
test('scoring completion DMs only the submitter with yellow results and working owner-scoped buttons',async t=>{
  const {store,job}=setup(t), sent=[];
  const recorder=new RecorderBridge(store,{log:()=>{}});recorder.activeJob=job;
  recorder.complete(game());
  const notifier=new CompletionNotifier({store,send:async(user,payload)=>sent.push({user,payload})});
  await notifier.tick();await notifier.tick();
  assert.equal(sent.length,1);assert.equal(sent[0].user,USER);
  assert.equal(sent[0].payload.embeds[0].color,YELLOW);
  assert.match(sent[0].payload.embeds[0].description,/my-replay.*finished scoring/s);
  assert.equal(sent[0].payload.components[0].components[0].custom_id,`rp:${USER}:detail:G00001`);
  assert.equal(store.completionDM(job.id).status,'sent');
  assert.equal(store.findJob('my-replay').status,'completed');
});
test('imported and failed replays do not send completion DMs',async t=>{
  const {store,job}=setup(t);store.importGame(game());store.fail(job.id,'Disconnected');
  let sent=0;await new CompletionNotifier({store,send:async()=>sent++}).tick();assert.equal(sent,0);
});
test('closed DMs do not break scoring or retry a permanent failure',async t=>{
  const {store,job}=setup(t);store.complete(job.id,game());let sent=0;
  const notifier=new CompletionNotifier({store,log:()=>{},send:async()=>{sent++;throw Object.assign(new Error('Cannot send messages to this user'),{code:50007});}});
  await notifier.tick();await notifier.tick();
  assert.equal(sent,1);assert.equal(store.completionDM(job.id).status,'failed');
  assert.equal(store.findJob('my-replay').status,'completed');assert.equal(store.games().length,1);
});
test('temporary failures retry with the same nonce, without overlapping sends',async t=>{
  let now=new Date('2026-09-04T12:00:00Z');const {store,job}=setup(t,{now:()=>now});store.complete(job.id,game());
  let release;const waiting=new Promise(r=>release=r), payloads=[];
  const notifier=new CompletionNotifier({store,log:()=>{},send:async(_user,payload)=>{
    payloads.push(payload);if(payloads.length===1){await waiting;throw new Error('Network error');}
  }});
  const first=notifier.tick(), overlapping=notifier.tick();assert.equal(payloads.length,1);
  release();await Promise.all([first,overlapping]);await notifier.tick();assert.equal(payloads.length,1);
  now=new Date(now.getTime()+31_000);await notifier.tick();
  assert.equal(payloads.length,2);assert.equal(payloads[0].nonce,payloads[1].nonce);
  assert.equal(payloads[1].enforceNonce,true);assert.equal(store.completionDM(job.id).status,'sent');
});
test('pending completion DMs survive restart, and sent ones are not resent',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'replay-dm-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const filename=path.join(dir,'replays.sqlite');let store=new ReplayStore(filename);
  store.whitelist(ADMIN_ID,USER);const job=store.submit(USER,'saved');store.claimNext();store.complete(job.id,game());store.close();
  store=new ReplayStore(filename);let sent=0;
  await new CompletionNotifier({store,send:async()=>sent++}).tick();store.close();
  store=new ReplayStore(filename);await new CompletionNotifier({store,send:async()=>sent++}).tick();store.close();assert.equal(sent,1);
});
test('legacy whitelist entries no longer gate completion notifications',async t=>{
  const {store,job}=setup(t);store.complete(job.id,game());store.whitelist(ADMIN_ID,USER,false);
  let sent=0;await new CompletionNotifier({store,send:async()=>sent++}).tick();
  assert.equal(sent,1);assert.equal(store.completionDM(job.id).status,'sent');
});
test('shutdown waits for an active send before returning',async t=>{
  const {store,job}=setup(t);store.complete(job.id,game());let release;
  const notifier=new CompletionNotifier({store,send:()=>new Promise(r=>release=r)});
  const sending=notifier.tick();let stopped=false;const stopping=notifier.stop().then(()=>stopped=true);
  await Promise.resolve();assert.equal(stopped,false);release();await Promise.all([sending,stopping]);
  assert.equal(stopped,true);assert.equal(store.completionDM(job.id).status,'sent');
});
test('invalid replay DMs persist across restart and send once without a results card',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'invalid-dm-'));
  const filename=path.join(dir,'replays.sqlite');let store=new ReplayStore(filename);
  t.after(()=>{if(store.db.isOpen)store.close();fs.rmSync(dir,{recursive:true,force:true});});
  store.whitelist(ADMIN_ID,USER);const job=store.submit(USER,'missing');store.claimNext();
  assert.equal(store.invalidate(job.id),true);assert.equal(store.invalidate(job.id),false);store.close();
  store=new ReplayStore(filename);const sent=[];
  const notifier=new CompletionNotifier({store,cards:{decorate:()=>assert.fail('invalid replays have no score card')},send:async(user,payload)=>sent.push({user,payload})});
  await notifier.tick();await notifier.tick();
  assert.equal(sent.length,1);assert.equal(sent[0].user,USER);
  assert.equal(sent[0].payload.embeds[0].title,'Replay not found');assert.equal(sent[0].payload.embeds[0].color,YELLOW);
  assert.match(sent[0].payload.embeds[0].description,/missing.*invalid.*next replay/s);
  assert.ok(sent[0].payload.components[0].components.every(c=>c.custom_id.startsWith(`rp:${USER}:`)));
  assert.equal(store.completionDM(job.id).status,'sent');assert.equal(store.getJob(job.id).status,'invalid');
  assert.equal(store.games().length,0);
});
test('blocked invalid-replay DM leaves the next job available and the invalid status saved',async t=>{
  const {store,job}=setup(t);store.invalidate(job.id);store.submit(USER,'next');
  const notifier=new CompletionNotifier({store,log:()=>{},send:async()=>{throw Object.assign(new Error('DMs closed'),{code:50007});}});
  await notifier.tick();
  assert.equal(store.completionDM(job.id).status,'failed');assert.equal(store.getJob(job.id).status,'invalid');
  assert.equal(store.claimNext().replay_id,'next');
});

test('short replays get a length notice instead of a score card',async t=>{
  const {store,job}=setup(t);const payload=game();payload.match.totalDurationSec=179;store.complete(job.id,payload);
  const sent=[];await new CompletionNotifier({store,send:async(_user,payload)=>sent.push(payload)}).tick();
  assert.equal(sent[0].embeds[0].title,'Replay not scored');assert.match(sent[0].embeds[0].description,/180 seconds.*next replay/s);
  assert.doesNotMatch(sent[0].embeds[0].description,/couldn’t find.*Hypixel/);assert.equal(sent[0].files,undefined);
});
test('a game voided before its completion DM is sent is clearly marked',async t=>{
  const {store,job}=setup(t);store.complete(job.id,game());store.setVoided(ADMIN_ID,'G1',true,'Wrong game');
  const sent=[];await new CompletionNotifier({store,send:async(_user,payload)=>sent.push(payload)}).tick();
  assert.equal(sent[0].embeds[0].title,'Your replay was voided');assert.match(sent[0].embeds[0].description,/Wrong game/);
});
