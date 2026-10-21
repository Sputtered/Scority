import test from 'node:test';
import assert from 'node:assert/strict';
import {ReplayStore,ADMIN_ID} from '../lib/discord/store.js';
import {RecorderBridge} from '../lib/discord/recorder.js';
import {ReplayAutomator} from '../lib/bot-orchestrator.js';
import {game} from './fixtures/discord-game.js';
const USER='111111111111111111';
const cfg={postSpawnDelayMs:0,postLobbyDelayMs:0,postCommandDelayMs:0,betweenReplaysDelayMs:0,
  movementIntervalMs:0,menuSlot:6,speedSlot:4,rightClickCount:0,speedSlotClickCount:0};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function fixture(t,options={}) {
  const store=new ReplayStore(':memory:');store.whitelist(ADMIN_ID,USER);
  const bridge=new RecorderBridge(store,{log:()=>{},...options}),writes=[];
  const bot=new ReplayAutomator({hypixelClient:{write:(name,data)=>writes.push({name,...data})},automationConfig:cfg,
    onReplayFinished:()=>bridge.complete(game())});
  t.after(()=>{bot.stop();store.close();});bridge.attach(bot);
  return {store,bridge,bot,writes};
}
test('offline submissions wait; real automator claims and scores exactly one at a time',async t=>{
  const {store,bridge,bot,writes}=fixture(t);
  store.submit(USER,'abc');store.submit(USER,'def');await bridge.tick();assert.equal(bridge.activeJob,null);
  await bot.onClientSpawned();bridge.spawned();assert.equal(bridge.activeJob.replay_id,'abc');
  assert.equal(store.queue().length,2);await bridge.tick();
  assert.equal(writes.filter(w=>w.message?.startsWith('/replay')).length,1);
  bridge.progress({state:'playing',elapsedSec:1,totalSec:600});
  bot.onActionBar({state:'finished',elapsedSec:600,totalSec:600});await wait(30);
  assert.equal(store.findJob('abc').status,'completed');assert.equal(store.games().length,1);
  assert.equal(bridge.activeJob.replay_id,'def');bot.stop();
});
test('pause waits for the active recording and resume starts the waiting one',async t=>{
  const {store,bridge,bot}=fixture(t);store.submit(USER,'abc');store.submit(USER,'def');await bot.onClientSpawned();
  store.pause(ADMIN_ID,true);bot.onActionBar({state:'finished',elapsedSec:600,totalSec:600});await wait(25);
  assert.equal(bridge.activeJob,null);assert.equal(store.findJob('def').status,'queued');
  store.pause(ADMIN_ID,false);await bridge.tick();await wait(20);assert.equal(bridge.activeJob.replay_id,'def');bot.stop();
});
test('loading timeout fails one job and continues with the next',async t=>{
  let now=0;const {store,bridge,bot}=fixture(t,{now:()=>now,loadTimeoutMs:100,maxLoadRetries:0});
  store.submit(USER,'bad');store.submit(USER,'good');await bot.onClientSpawned();
  now=101;await bridge.tick();await wait(20);
  assert.equal(store.findJob('bad').status,'failed');assert.equal(bridge.activeJob.replay_id,'good');bot.stop();
});

test('a missing HUD retries once without another quota charge and then advances',async t=>{
  let now=0;const {store,bridge,bot}=fixture(t,{now:()=>now,loadTimeoutMs:100});
  const first=store.submit(USER,'slow');store.submit(USER,'next');await bot.onClientSpawned();
  now=101;await bridge.tick();await wait(20);
  assert.equal(bridge.activeJob.id,first.id);assert.equal(bridge.activeJob.load_retries,1);
  assert.equal(bridge.activeJob.attempts,2);assert.equal(store.quota(USER).used,2);
  now=202;await bridge.tick();await wait(20);
  assert.equal(store.getJob(first.id).status,'failed');assert.equal(bridge.activeJob.replay_id,'next');
  assert.equal(store.getJob(first.id).load_retries,1);assert.equal(store.games().length,0);
  const retry=store.retry(ADMIN_ID,`R${first.id}`);assert.equal(retry.load_retries,0);
});

test('load timeout checks return while lobby work is pending and ignore errors from replaced sessions',async t=>{
  let now=0;const {store,bridge,bot}=fixture(t,{now:()=>now,loadTimeoutMs:100});
  store.submit(USER,'slow');await bot.onClientSpawned();
  let rejectTransition;const transition=new Promise((_,reject)=>rejectTransition=reject);
  bot.skipCurrent=()=>transition;
  now=101;await bridge.tick();
  assert.equal(store.findJob('slow').status,'queued');
  await bridge.tick();assert.equal(store.findJob('slow').load_retries,1);
  const next={queue:[],stopped:false,broken:false};bridge.attach(next);bot.stop();
  rejectTransition(new Error('Old transition failed'));await wait(0);
  assert.equal(next.broken,false);assert.equal(bridge.automator,next);
});
test('disconnect marks only the active replay failed, without scoring partial data',async t=>{
  const {store,bridge,bot}=fixture(t);store.submit(USER,'a');store.submit(USER,'b');await bot.onClientSpawned();bot.stop();bridge.detach('Disconnected');
  assert.equal(store.findJob('a').status,'failed');assert.equal(store.findJob('b').status,'queued');assert.equal(store.games().length,0);
});
test('empty recording fails without throwing or creating a game',async t=>{
  const {store,bridge,bot}=fixture(t);store.submit(USER,'empty');await bot.onClientSpawned();
  assert.equal(bridge.complete({match:{totalDurationSec:600},players:{},killFeed:[],bedBreaks:[]}),null);
  assert.equal(store.findJob('empty').status,'failed');assert.equal(store.games().length,0);bot.stop();
});
test('missing replay notice invalidates once, saves a DM and advances without scoring',async t=>{
  const {store,bridge,bot,writes}=fixture(t);
  const job=store.submit(USER,'missing');store.submit(USER,'next');await bot.onClientSpawned();
  const skipping=bridge.onChat({text:'§cCouldn\'t find a replay ',extra:[{text:'by that UUID!'}]});
  assert.equal(await bridge.onChat("Couldn't find a replay by that UUID!"),false,'duplicate while returning to lobby');
  assert.equal(await skipping,true);
  assert.equal(store.getJob(job.id).status,'invalid');assert.equal(store.games().length,0);
  assert.equal(store.getJob(job.id).load_retries,0,'known invalid replay must not retry');
  assert.equal(store.completionDM(job.id).status,'pending');assert.equal(store.quota(USER).used,2);
  assert.equal(bridge.activeJob.replay_id,'next');assert.equal(store.position(job.id),null);
  assert.deepEqual(writes.filter(w=>w.message?.startsWith('/replay')).map(w=>w.message),['/replay missing','/replay next']);
  assert.equal(bot.broken,false);
});
test('chat quotes, idle notices and notices after playback starts do not invalidate replays',async t=>{
  const {store,bridge,bot}=fixture(t), notice="Couldn't find a replay by that UUID!";
  assert.equal(await bridge.onChat(notice),false);
  const job=store.submit(USER,'good');await bot.onClientSpawned();
  assert.equal(await bridge.onChat(`[MVP+] Someone: ${notice}`),false);
  bridge.progress({state:'playing',elapsedSec:1,totalSec:600});
  assert.equal(await bridge.onChat(notice),false);
  assert.equal(store.getJob(job.id).status,'recording');assert.equal(store.nextCompletionDM(),undefined);
});
test('invalid replay honors a paused queue and can leave the recorder idle',async t=>{
  const {store,bridge,bot}=fixture(t);
  store.submit(USER,'missing');store.submit(USER,'waiting');await bot.onClientSpawned();store.pause(ADMIN_ID,true);
  await bridge.onChat("Couldn't find a replay by that UUID!");
  assert.equal(bridge.activeJob,null);assert.equal(bot.busy,false);assert.equal(store.findJob('waiting').status,'queued');
  store.pause(ADMIN_ID,false);await bridge.tick();await wait(20);
  assert.equal(bridge.activeJob.replay_id,'waiting');
});

test('short replay detection cancels menu work and honors pause before continuing',async t=>{
  const {store,bridge,bot,writes}=fixture(t);const short=store.submit(USER,'short');store.submit(USER,'next');
  await bot.onClientSpawned();store.pause(ADMIN_ID,true);
  assert.equal(bridge.progress({state:'playing',elapsedSec:1,totalSec:179,speed:16}),false);
  await wait(20);assert.equal(store.getJob(short.id).status,'invalid');assert.equal(store.completionDM(short.id).status,'pending');
  assert.equal(bot.busy,false);assert.equal(bridge.activeJob,null);assert.equal(store.games().length,0);
  assert.equal(bridge.progress({state:'finished',elapsedSec:179,totalSec:179}),false);
  assert.equal(writes.filter(w=>w.message?.startsWith('/replay')).length,1);
  store.pause(ADMIN_ID,false);await bridge.tick();await wait(20);
  assert.equal(bridge.activeJob.replay_id,'next');assert.equal(bridge.progress({state:'playing',elapsedSec:1,totalSec:180,speed:16}),true);
});
