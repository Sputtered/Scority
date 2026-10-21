import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplayAutomator } from '../lib/bot-orchestrator.js';
const cfg = {postSpawnDelayMs:10, postLobbyDelayMs:10, postCommandDelayMs:10,
  betweenReplaysDelayMs:10, rightClickCount:0, speedSlotClickCount:0,
  menuSlot:6, speedSlot:4, movementIntervalMs:0};
const delay = ms => new Promise(r => setTimeout(r,ms));
function make(onReplayFinished) {
  const writes = [];
  const bot = new ReplayAutomator({hypixelClient:{write:(name,data)=>writes.push({name,...data})}, automationConfig:cfg, onReplayFinished});
  return {bot,writes};
}
test('poll during spawn delay does not start two queued replays', async () => {
  const {bot,writes}=make(); bot.setQueue(['/replay one','/replay two']);
  const starting=bot.onClientSpawned(); bot.resumeIfIdle();
  await starting; await delay(45); bot.stop();
  assert.deepEqual(writes.filter(w=>w.message?.startsWith('/replay')).map(w=>w.message), ['/replay one']);
});
test('poll during save cannot advance a second replay before save completes', async () => {
  let release; const saving = new Promise(r=>release=r);
  const {bot,writes}=make(()=>saving); bot.setQueue(['/replay one']);
  await bot.onClientSpawned();
  bot.onActionBar({state:'finished',elapsedSec:10,totalSec:10});
  bot.queue.push('/replay two'); bot.resumeIfIdle();
  await delay(45);
  const duringSave = writes.filter(w=>w.message?.startsWith('/replay')).length;
  bot.stop(); release(); await delay(30);
  assert.equal(duringSave,1);
});
test('idle finished HUD does not save an unqueued replay', async () => {
  let saves=0; const {bot}=make(()=>saves++);
  await bot.onClientSpawned();
  bot.onActionBar({state:'finished',elapsedSec:10,totalSec:10});
  await delay(30); bot.stop(); assert.equal(saves,0);
});
test('disconnect during spawn delay cannot restart movement timer', async () => {
  const {bot}=make(); bot.cfg={...cfg,movementIntervalMs:10000};
  const starting=bot.onClientSpawned(); bot.stop(); await starting;
  const timer=bot.movementTimer; bot.stop(); assert.equal(timer,null);
});

test('relative server position flags update the movement origin', () => {
  const {bot}=make();
  bot.trackPosition({x:10,y:20,z:30,yaw:40,pitch:50,flags:0});
  bot.trackPosition({x:1,y:2,z:3,yaw:4,pitch:5,flags:0x1f});
  assert.deepEqual(bot.lastKnownPosition,{x:11,y:22,z:33,yaw:44,pitch:55});
});
test('a failed save halts the queue and preserves the next entry', async () => {
  const {bot,writes}=make(()=>{throw new Error('disk full');});
  bot.setQueue(['/replay one','/replay two']); await bot.onClientSpawned();
  bot.onActionBar({state:'finished',elapsedSec:10,totalSec:10});
  await delay(40); bot.stop();
  assert.equal(bot.broken,true);
  assert.deepEqual(bot.queue,['/replay two']);
  assert.equal(writes.filter(w=>w.message?.startsWith('/replay')).length,1);
});
test('a completed replay cancels its pending menu sequence', async () => {
  const {bot,writes}=make(); bot.cfg={...cfg,postCommandDelayMs:80};
  bot.setQueue(['/replay one']); const starting=bot.onClientSpawned();
  await delay(40);
  bot.onActionBar({state:'finished',elapsedSec:10,totalSec:10});
  await starting; bot.stop();
  assert.equal(writes.some(w=>w.name==='held_item_slot'),false);
});
test('automation sends the replay command without its time marker',async()=>{
  const id='8dcb02bb-6e61-4c0f-a435-40e1712f4661';
  for (const entry of [`/replay ${id} #14cb857e`,{command:`/replay ${id} #14cb857e`,replayId:`${id} #14cb857e`,submissionId:42}]) {
    const {bot,writes}=make();bot.setQueue([entry]);
    await bot.onClientSpawned();bot.stop();
    assert.deepEqual(writes.filter(w=>w.message?.startsWith('/replay')).map(w=>w.message),[`/replay ${id}`]);
    assert.equal(bot.currentReplayId,id);
  }
});

test('replay speed is adjusted from HUD feedback and resumes only after reaching the target',()=>{
  const {bot,writes}=make();bot.cfg={...cfg,replaySpeed:4};bot.started=true;bot.activeReplay=true;
  bot.onActionBar({state:'paused',elapsedSec:0,totalSec:120,speed:1});
  bot.playbackControlAt=0;bot.onActionBar({state:'paused',elapsedSec:0,totalSec:120,speed:2});
  bot.playbackControlAt=0;bot.onActionBar({state:'paused',elapsedSec:0,totalSec:120,speed:4});
  bot.playbackControlAt=0;bot.onActionBar({state:'playing',elapsedSec:4,totalSec:120,speed:4});
  assert.deepEqual(writes.filter(w=>w.name==='held_item_slot').map(w=>w.slotId),[6,6,4]);
  assert.equal(writes.filter(w=>w.name==='block_place').length,3);bot.stop();
});
