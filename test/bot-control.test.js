import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {ManagedConnection} from '../lib/managed-connection.js';
import {ControlStore} from '../lib/control-store.js';
import {ReplayStore,ADMIN_ID} from '../lib/discord/store.js';
import {RecorderBridge} from '../lib/discord/recorder.js';
import {BotControl} from '../lib/discord/control.js';

function setup(t){const store=new ReplayStore(':memory:');t.after(()=>store.close());const data=new ControlStore(store);return {store,data};}
function connection(t){
  const {data}=setup(t);let now=0,clients=[],values=data.settings().values;
  const manager=new ManagedConnection({now:()=>now,random:()=>0,settings:()=>values,connect:()=>{const c=new EventEmitter();c.end=()=>c.emit('end','closed');clients.push(c);return c;}});
  return {manager,clients,values,advance:ms=>{now+=ms;manager.tick();}};
}
test('kick, error, and end schedule one retry with increasing delays',t=>{
  const {manager,clients,advance}=connection(t);manager.tick();assert.equal(clients.length,1);
  clients[0].emit('position',{});clients[0].emit('kick_disconnect',{reason:JSON.stringify({text:'Timed out'})});
  clients[0].emit('error',new Error('socket closed'));clients[0].emit('end','closed');
  assert.equal(manager.status().lastDisconnect.reason,'Timed out');assert.equal(manager.nextRetryAt,10000);
  advance(9999);assert.equal(clients.length,1);advance(1);assert.equal(clients.length,2);
  clients[1].emit('end','failure');assert.equal(manager.nextRetryAt,30000);
  advance(20000);assert.equal(clients.length,3);manager.stop();advance(999999);assert.equal(clients.length,3);
});
test('login and silent-connection watchdogs reconnect; healthy connections reset backoff',t=>{
  const {manager,clients,advance}=connection(t);manager.tick();advance(120000);assert.equal(manager.state,'waiting');
  advance(10000);clients[1].emit('position',{});advance(60000);assert.equal(manager.attempts,0);
  advance(30000);assert.equal(manager.state,'waiting');assert.match(manager.lastDisconnect.reason,/No packets/);
});
test('manual reconnect finalizes the old recorder before creating another session',t=>{
  const {data}=setup(t),order=[];
  const manager=new ManagedConnection({settings:()=>data.settings().values,connect:()=>{
    order.push('connect');const client=new EventEmitter();client.end=()=>{};
    return {client,close:()=>order.push('finalize')};
  }});
  manager.tick();manager.request('reconnect');manager.tick();
  assert.deepEqual(order,['connect','finalize','connect']);manager.stop();
});
test('auto rejoin off stays offline even after a healthy connection; manual connect works',t=>{
  const {manager,clients,values,advance}=connection(t);values['connection.autoRejoin']=false;
  manager.tick();clients[0].emit('position',{});advance(60000);clients[0].emit('end','kick');advance(200000);
  assert.equal(clients.length,1);manager.request('connect');manager.tick();assert.equal(clients.length,2);
  values['connection.enabled']=false;manager.request('disconnect');advance(999999);assert.equal(clients.length,2);assert.equal(manager.state,'offline');
  values['connection.enabled']=true;manager.tick();assert.equal(clients.length,3);manager.stop();
});
test('settings validate all fields atomically, reject stale edits, persist, and alter quotas',t=>{
  const {store,data}=setup(t);const a=data.settings();assert.ok(a.schema.length>=35);
  assert.throws(()=>data.save(ADMIN_ID,a.version,{'targetPort':0,'connection.autoRejoin':false}),/between/);
  assert.equal(data.settings().values['connection.autoRejoin'],true);
  assert.throws(()=>data.save(ADMIN_ID,a.version,{'shell':'x'}),/Unknown setting/);
  assert.throws(()=>data.save(ADMIN_ID,a.version,{'connection.retryDelayMs':500000}),/Maximum retry/);
  const b=data.save(ADMIN_ID,a.version,{'submissions.dailyLimit':8,'connection.autoRejoin':false});
  assert.throws(()=>data.save(ADMIN_ID,a.version,{}),/another tab/);
  assert.equal(store.quota(ADMIN_ID).limit,8);assert.equal(new ControlStore(store).settings().version,b.version);
  data.save(ADMIN_ID,b.version,{'submissions.enabled':false});assert.throws(()=>store.submit(ADMIN_ID,'test'),/temporarily disabled/);
});
test('commands require a fresh recorder, expire, and are recovered without repeating actions',t=>{
  const {data}=setup(t);assert.throws(()=>data.enqueue(ADMIN_ID,'reconnect'),/offline/);
  data.publish({});const cmd=data.enqueue(ADMIN_ID,'connect');assert.equal(cmd.status,'pending');
  assert.throws(()=>data.enqueue(ADMIN_ID,'reconnect'),/current bot action/);
  assert.equal(data.claim().id,cmd.id);assert.equal(data.claim(),undefined);data.recover();assert.equal(data.command(cmd.id).status,'failed');
  const next=data.enqueue(ADMIN_ID,'disconnect');data.db.prepare('UPDATE bot_commands SET created_at=0 WHERE id=?').run(next.id);
  assert.equal(data.claim(),undefined);assert.equal(data.command(next.id).status,'failed');
});
test('disconnect retries preserve replay identity and quota, stop at the configured limit',t=>{
  const {store}=setup(t);const job=store.submit(ADMIN_ID,'interrupted'),recorder=new RecorderBridge(store);
  recorder.retryInterrupted=true;recorder.maxDisconnectRetries=1;
  recorder.activeJob=store.claimNext();recorder.detach('Timed out');
  assert.equal(store.getJob(job.id).status,'queued');assert.equal(store.games().length,0);assert.equal(store.quota(ADMIN_ID).used,1);
  recorder.activeJob=store.claimNext();recorder.detach('Kicked again');assert.equal(store.getJob(job.id).status,'failed');
});
test('disconnect persists intentional offline state and status is marked stale on shutdown',async t=>{
  const {store}=setup(t),recorder=new RecorderBridge(store),control=new BotControl(store,recorder);
  control.bind(()=>{const c=new EventEmitter();c.end=()=>c.emit('end','closed');return c;});
  control.pulse();await control.execute('disconnect');control.pulse();
  assert.equal(control.data.settings().values['connection.enabled'],false);assert.equal(control.connection.state,'offline');
  await control.execute('connect');assert.equal(control.connection.state,'connecting');control.stop();assert.equal(control.data.status().available,false);
});

test('pending Discord changes do not block commands and newer changes are applied after draining',async t=>{
  const {store}=setup(t),recorder=new RecorderBridge(store),control=new BotControl(store,recorder);
  control.bind(()=>{const c=new EventEmitter();c.end=()=>c.emit('end','closed');return c;});
  let release;const draining=new Promise(resolve=>release=resolve),applied=[];
  control.applyDiscord=async values=>{applied.push(values['discord.completionNotifications']);if(applied.length===1)await draining;};
  control.pulse();await control.tick();
  assert.equal(control.data.status().available,true);
  const command=control.data.enqueue(ADMIN_ID,'disconnect');
  control.data.save(ADMIN_ID,control.data.settings().version,{'discord.completionNotifications':false});
  await control.tick();await control.tick();
  assert.equal(control.data.command(command.id).status,'succeeded');
  assert.equal(control.connection.state,'offline');assert.deepEqual(applied,[true]);
  assert.equal(control.data.status().discordSettings.applying,true);
  release();await control.discordTask;
  assert.deepEqual(applied,[true,false]);
  assert.equal(control.discordAppliedVersion,control.data.settings().version);
  control.stop();
});

test('a fresh heartbeat cannot hide a stale or failed command processor',async t=>{
  const {store}=setup(t),recorder=new RecorderBridge(store),control=new BotControl(store,recorder);
  control.bind(()=>{const c=new EventEmitter();c.end=()=>c.emit('end');return c;});
  await control.tick();control.pulse();assert.equal(control.data.status().available,true);
  control.processors.control.lastCompletedAt=Date.now()-16000;control.pulse();
  assert.equal(control.data.status().serviceAvailable,true);assert.equal(control.data.status().available,false);
  assert.throws(()=>control.data.enqueue(ADMIN_ID,'disconnect'),/command processor/);
  const apply=control.apply;control.apply=()=>{throw new Error('Settings failed');};
  await assert.rejects(control.tick(),/Settings failed/);control.pulse();
  assert.equal(control.data.status().processors.control.error,'Settings failed');
  assert.equal(control.data.status().available,false);
  control.apply=apply;await control.tick();assert.equal(control.data.status().available,true);control.stop();
});
