import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchApprovedReplayQueue, startAutoQueuePolling } from '../lib/bot-orchestrator.js';
const delay = ms => new Promise(r => setTimeout(r,ms));

test('pipeline polls never overlap and preserve claimed results after stop', async t => {
  let calls=0, release;
  t.mock.method(globalThis,'fetch',async (_url,options)=> {
    calls++; assert.ok(options.signal);
    await new Promise(r=>release=r);
    return {ok:true,json:async()=>({replays:[{replayId:'abc',id:3}]})};
  });
  const automator={queue:[],resumeIfIdle(){}};
  const timer=startAutoQueuePolling(automator,{pollIntervalMs:5,pendingReplaysUrl:'https://example.invalid',apiKey:'test'});
  try {
    await delay(35); assert.equal(calls,1);
    automator.stopped=true; clearInterval(timer); release(); await delay(5);
    assert.deepEqual(automator.queue,[{command:'/replay abc',replayId:'abc',submissionId:3}]);
  } finally { clearInterval(timer); release?.(); }
});
test('pipeline handles HTTP errors and disabled credentials', async t => {
  let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return {ok:false,status:503};});
  assert.deepEqual(await fetchApprovedReplayQueue({}),[]);
  assert.equal(calls,0);
  assert.deepEqual(await fetchApprovedReplayQueue({pendingReplaysUrl:'https://example.invalid',apiKey:'test'}),[]);
});
