import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {ReplayStore,ADMIN_ID} from '../lib/discord/store.js';
import {RecorderPool} from '../lib/discord/recorder-pool.js';
import {BotControl} from '../lib/discord/control.js';
import {recorderAccounts} from '../lib/recorder-accounts.js';
import {game} from './fixtures/discord-game.js';

const accounts=recorderAccounts('one@example.test,two@example.test','./mc-auth-cache');
function fixture(t){const store=new ReplayStore(':memory:');t.after(()=>store.close());return {store,pool:new RecorderPool(store,accounts)};}

test('account caches are separate and stable when reordered; duplicate identities fail closed',()=>{
  const reversed=recorderAccounts(' TWO@example.test , one@example.test ','./mc-auth-cache');
  assert.equal(accounts[0].id,reversed[1].id);assert.equal(accounts[1].authCacheDir,reversed[0].authCacheDir);
  assert.notEqual(accounts[0].authCacheDir,accounts[1].authCacheDir);
  assert.deepEqual(recorderAccounts('','./cache'),[]);
  assert.throws(()=>recorderAccounts('one@example.test,ONE@example.test','./cache'),/unique/);
  assert.throws(()=>recorderAccounts('one@example.test,','./cache'),/comma-separated/);
});

test('two recorders claim distinct jobs; one slot per account, priority and pause remain global',t=>{
  const {store,pool}=fixture(t),[one,two]=pool.workers.map(w=>w.recorder);
  const normal='111111111111111111',priority='222222222222222222';
  store.setPriority(ADMIN_ID,priority,true);
  store.submit(normal,'normal');store.submit(priority,'priority');store.submit(normal,'waiting');
  assert.equal(one.queue.shift().replayId,'priority');assert.equal(two.queue.shift().replayId,'normal');
  assert.equal(one.queue.shift(),null);assert.equal(two.queue.shift(),null);
  assert.equal(pool.status().workers.filter(w=>w.active).length,2);
  store.pause(ADMIN_ID,true);one.complete(game({index:1}));two.complete(game({index:2}));
  assert.equal(store.games().length,2);assert.equal(store.db.prepare('SELECT count(*) AS n FROM completion_dms').get().n,2);
  assert.equal(one.queue.shift(),null);assert.equal(two.queue.shift(),null);
  store.pause(ADMIN_ID,false);assert.equal(two.queue.shift().replayId,'waiting');
});

test('reopening a database with two active recordings preserves both and recovers once',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scority-pool-')),file=path.join(dir,'db.sqlite');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const first=new ReplayStore(file);
  first.submit(ADMIN_ID,'first');first.submit(ADMIN_ID,'second');first.submit(ADMIN_ID,'third');
  first.claimNext('one');first.claimNext('two');
  const second=new ReplayStore(file);
  try{
    assert.equal(second.claimNext('one'),null);assert.equal(second.claimNext('two'),null);
    assert.equal(second.queue().filter(j=>j.status==='recording').length,2);
    assert.equal(second.recover(),2);assert.equal(second.recover(),0);
    assert.equal(second.claimNext('one').replay_id,'first');assert.equal(first.claimNext('two').replay_id,'second');
    assert.equal(second.quota(ADMIN_ID).used,3);
  }finally{second.close();first.close();}
});

test('old one-recording databases migrate without losing an active job',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scority-migrate-')),file=path.join(dir,'db.sqlite');
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let store=new ReplayStore(file);store.submit(ADMIN_ID,'old');store.submit(ADMIN_ID,'new');store.claimNext();
  store.db.exec("DROP INDEX one_recording_per_worker; ALTER TABLE jobs DROP COLUMN worker_id; CREATE UNIQUE INDEX one_recording ON jobs(status) WHERE status='recording';");store.close();
  store=new ReplayStore(file);
  try{assert.equal(store.findJob('old').status,'recording');assert.equal(store.claimNext(),null);assert.equal(store.claimNext('second').replay_id,'new');}
  finally{store.close();}
});

test('one account disconnects and retries without interrupting the other; targeted controls and shutdown work',async t=>{
  const {store,pool}=fixture(t),control=new BotControl(store,pool),clients=[];
  t.after(()=>control.stop());
  control.bind(worker=>{
    const client=new EventEmitter();client.end=()=>client.emit('end','closed');clients.push(client);
    worker.recorder.attach({cfg:{},stop(){},skipCurrent:async()=>{},sendChat(){}});
    return {client,close:reason=>worker.recorder.detach(reason)};
  });
  control.pulse();clients.forEach(c=>c.emit('position',{}));
  const [one,two]=pool.workers.map(w=>w.recorder);
  store.submit(ADMIN_ID,'first');store.submit(ADMIN_ID,'second');one.queue.shift();two.queue.shift();
  await assert.rejects(control.execute('skip'),/Choose/);
  clients[0].emit('end','Lost connection');
  assert.equal(store.findJob('first').status,'queued');assert.equal(store.findJob('second').status,'recording');
  assert.equal(two.activeJob.replay_id,'second');
  await control.execute('skip',{workerId:pool.workers[1].id});assert.equal(store.findJob('second').status,'failed');
  await control.execute('disconnect');assert.ok(pool.workers.every(w=>w.connection.state==='offline'));
  control.pulse();assert.equal(clients.length,2);
  await control.execute('connect');assert.equal(clients.length,4);
  control.stop();assert.equal(control.data.status().available,false);
});
