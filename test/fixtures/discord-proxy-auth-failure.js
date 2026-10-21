import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import {PassThrough} from 'node:stream';
import mc from 'minecraft-protocol';
import config from '../../config.js';
import {ReplayStore,ADMIN_ID} from '../../lib/discord/store.js';
import {RecorderBridge} from '../../lib/discord/recorder.js';
import {BotControl} from '../../lib/discord/control.js';
import {setDiscordRuntime} from '../../lib/discord/runtime.js';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'scority-auth-failure-'));
const originalInterval=globalThis.setInterval,originalClear=globalThis.clearInterval;
const timers=new Set(),createClient=mc.createClient,createServer=mc.createServer;
let local,store,control;
globalThis.setInterval=(fn,delay,...args)=>{const timer=originalInterval(fn,delay,...args);if(delay===50)timers.add(timer);return timer;};
globalThis.clearInterval=timer=>{timers.delete(timer);originalClear(timer);};
try{
  config.outputDir=path.join(directory,'output');config.authCacheDir=path.join(directory,'auth');config.mojangUsername='Fixture';
  mc.createClient=()=>createClient({version:'1.8.9',username:'Fixture',auth:()=>{}});
  mc.createServer=options=>(local=createServer({...options,'online-mode':false,host:'127.0.0.1',port:0,keepAlive:false}));
  store=new ReplayStore(':memory:');const recorder=new RecorderBridge(store);control=new BotControl(store,recorder);
  setDiscordRuntime({store,recorder,control});await import('../../proxy.js');
  if(!local.socketServer.listening)await once(local,'listening');
  let abandoned;
  for(let attempt=0;attempt<3;attempt++){
    control.connection.request('connect');control.pulse();
    assert.equal(timers.size,1);assert.equal(control.connection.client.socket,undefined);
    abandoned=control.connection.client;
    abandoned.emit('error',new Error('Authentication failed before TCP connection'));
    assert.equal(timers.size,0,'session finalization must stop the viewer without an end event');
  }
  control.connection.request('connect');control.pulse();assert.equal(timers.size,1);
  const replacement=control.connection.client,job=store.submit(ADMIN_ID,'replacement-replay');recorder.activeJob=store.claimNext();
  let staleWrites=0;abandoned.write=()=>{staleWrites++;};abandoned.writeChannel=()=>{staleWrites++;};
  const lateSocket=new PassThrough();abandoned.setSocket(lateSocket);
  assert.equal(lateSocket.destroyed,true);assert.equal(abandoned.socket,undefined);
  abandoned.emit('login',{});
  abandoned.emit('position',{x:0,y:64,z:0,yaw:0,pitch:0,flags:0});
  abandoned.emit('packet',{x:0,y:64,z:0,yaw:0,pitch:0,flags:0},{name:'position',state:'play'});
  abandoned.emit('packet',{message:JSON.stringify({text:"Couldn't find a replay by that UUID!"}),position:0},{name:'chat',state:'play'});
  assert.equal(staleWrites,0,'abandoned headless callbacks must not send packets');
  assert.equal(control.connection.client,replacement);assert.equal(recorder.connection,'connecting');
  assert.equal(recorder.activeJob.id,job.id);assert.equal(store.getJob(job.id).status,'recording');
  control.stop();assert.equal(timers.size,0,'shutdown must stop a pending-auth viewer');
  console.log('DISCORD_PROXY_AUTH_CLEANUP_OK');
}catch(error){console.error(error);process.exitCode=1;}
finally{
  control?.stop();local?.close();store?.close();
  for(const timer of timers)originalClear(timer);
  globalThis.setInterval=originalInterval;globalThis.clearInterval=originalClear;
  if(path.dirname(directory)===path.resolve(os.tmpdir()))fs.rmSync(directory,{recursive:true,force:true});
}
