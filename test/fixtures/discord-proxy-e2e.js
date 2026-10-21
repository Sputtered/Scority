import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import mc from 'minecraft-protocol';
import chunkFactory from 'prismarine-chunk';
import {Vec3} from 'vec3';
import config from '../../config.js';
import {ReplayStore,ADMIN_ID} from '../../lib/discord/store.js';
import {RecorderBridge} from '../../lib/discord/recorder.js';
import {setDiscordRuntime} from '../../lib/discord/runtime.js';
import {BotControl} from '../../lib/discord/control.js';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'discord-proxy-'));
const createServer=mc.createServer,createClient=mc.createClient;
const invalidFirst=process.argv.includes('invalid-first');
const shortFirst=process.argv.includes('short-first');
const managed=process.argv.includes('managed-kick');
let upstream,local,viewer,store,control,pulse,upstreamConnections=0,kicked=false;
try {
  config.outputDir=path.join(dir,'output');config.authCacheDir=path.join(dir,'auth');
  config.mojangUsername='Fixture';
  config.automation={...config.automation,postSpawnDelayMs:0,postLobbyDelayMs:0,postCommandDelayMs:0,
    betweenReplaysDelayMs:0,movementIntervalMs:0,rightClickCount:0,speedSlotClickCount:0};
  config.pipeline={uploadUrl:'https://example.invalid/upload',pendingReplaysUrl:'https://example.invalid/queue',apiKey:'fixture',autoQueue:true};
  let externalRequests=0;globalThis.fetch=()=>{externalRequests++;throw new Error('External HTTP is forbidden in this test');};
  upstream=createServer({'online-mode':false,host:'127.0.0.1',port:0,version:'1.8.9',keepAlive:false});
  await once(upstream,'listening');
  upstream.on('login',peer=>{
    upstreamConnections++;
    peer.write('login',{entityId:1,gameMode:0,dimension:0,difficulty:0,maxPlayers:1,levelType:'default',reducedDebugInfo:false});
    peer.write('position',{x:0,y:64,z:0,yaw:0,pitch:0,flags:0});
    peer.on('chat',({message})=>{
      const chat=(text,position=0)=>peer.write('chat',{message:JSON.stringify({text}),position});
      if(message==='/replay missing-replay') {
        chat("§cCouldn't find a replay by that UUID!");return;
      }
      if(message==='/replay short-replay') {
        chat('§aPlaying §e00:01 / 02:59 §616.0x',2);
        chat('§aMikowa §7was killed by §cSputtered§7. FINAL KILL!');
        chat('§cFinished §e02:59 / 02:59 §616.0x',2);return;
      }
      if(message!=='/replay fixture-replay') return;
      if(managed&&!kicked){
        kicked=true;chat('§aPlaying §e00:00 / 03:00 §64.0x',2);
        peer.end(JSON.stringify({text:'Timed out'}));return;
      }
      chat('§aPlaying §e00:00 / 03:00 §64.0x',2);
      const names=['Sputtered','Mikowa'];
      const uuids=names.map((_,i)=>`00000000-0000-0000-0000-00000000000${i+1}`);
      peer.write('player_info',{action:'add_player',data:names.map((name,i)=>({uuid:uuids[i],name,properties:[],gamemode:0,ping:0,displayName:null}))});
      names.forEach((name,i)=>peer.write('scoreboard_team',{team:name,mode:0,name,prefix:i===0?'\u00a7c':'\u00a7a',suffix:'',friendlyFire:0,nameTagVisibility:'always',color:i===0?12:10,players:[name]}));
      names.forEach((_,i)=>peer.write('named_entity_spawn',{entityId:10+i,playerUUID:uuids[i],x:16+i*64,y:2096,z:16,
        yaw:i===0?-64:64,pitch:0,currentItem:0,metadata:[{key:6,type:3,value:20}]}));
      const Chunk=chunkFactory('1.8.9'),chunk=new Chunk();
      chunk.setBlockType(new Vec3(10,65,0),130);
      peer.write('map_chunk',{x:0,z:0,groundUp:true,bitMap:16,chunkData:chunk.dump(16)});
      for(const [entityId,blockId,itemCount] of [[20,264,4],[21,388,2]]) {
        peer.write('spawn_entity',{entityId,type:2,x:976,y:2160,z:16,pitch:0,yaw:0,objectData:1,velocity:{x:0,y:0,z:0}});
        peer.write('entity_metadata',{entityId,metadata:[{key:10,type:5,value:{blockId,itemCount,itemDamage:0}}]});
        peer.write('collect',{collectedEntityId:entityId,collectorEntityId:10});
      }
      peer.write('animation',{entityId:10,animation:0});
      peer.write('entity_status',{entityId:11,entityStatus:2});
      peer.write('entity_metadata',{entityId:11,metadata:[{key:6,type:3,value:16.5}]});
      peer.write('entity_teleport',{entityId:10,x:176,y:2096,z:16,yaw:-64,pitch:0,onGround:true});
      peer.write('entity_teleport',{entityId:11,x:80,y:-320,z:16,yaw:64,pitch:0,onGround:false});
      chat('§aMikowa §7was killed by §cSputtered§7. FINAL KILL!');
      peer.write('entity_metadata',{entityId:11,metadata:[{key:6,type:3,value:0}]});
      // time jumps count as seeks
      for(let t=4;t<180;t+=4)chat(`§aPlaying §e${String(Math.floor(t/60)).padStart(2,'0')}:${String(t%60).padStart(2,'0')} / 03:00 §64.0x`,2);
      chat('§cFinished §e03:00 / 03:00 §64.0x',2);
    });
  });
  mc.createClient=()=>createClient({host:'127.0.0.1',port:upstream.socketServer.address().port,
    version:'1.8.9',auth:'offline',username:'Fixture',keepAlive:false});
  let downstreamPeer;
  mc.createServer=options=>{
    local=createServer({...options,'online-mode':false,host:'127.0.0.1',port:0,keepAlive:false});
    local.on('login',peer=>{downstreamPeer=peer;});return local;
  };
  store=new ReplayStore(':memory:');
  if(invalidFirst) store.submit(ADMIN_ID,'missing-replay');
  if(shortFirst) store.submit(ADMIN_ID,'short-replay');
  const goodJob=store.submit(ADMIN_ID,'fixture-replay');
  const recorder=new RecorderBridge(store,{log:()=>{}});
  let completed;
  const finished=new Promise(resolve=>completed=resolve);
  const complete=recorder.complete.bind(recorder);
  recorder.complete=payload=>{const game=complete(payload);completed(game);return game;};
  if(managed){
    control=new BotControl(store,recorder);const settings=control.data.settings();
    control.data.save(ADMIN_ID,settings.version,{'connection.retryDelayMs':1000,'connection.maxRetryDelayMs':1000});
    control.values=control.data.settings().values;control.apply();
  }
  setDiscordRuntime({store,recorder,control});
  await import('../../proxy.js');
  if(!local.socketServer.listening) await once(local,'listening');
  if(managed)pulse=setInterval(()=>control.pulse(),20);
  else viewer=createClient({host:'127.0.0.1',port:local.socketServer.address().port,version:'1.8.9',auth:'offline',username:'Viewer',keepAlive:false});
  const game=await finished;
  assert.equal(game.replay_id,'fixture-replay');
  assert.equal(game.payload.players.Sputtered.kills,1);
  assert.equal(game.payload.tracking.status,'tracked');
  assert.deepEqual(game.payload.tracking.chunkErrors,[]);
  assert.equal(game.payload.players.Sputtered.diamondsCollected,4);
  assert.equal(game.payload.players.Sputtered.emeraldsCollected,2);
  assert.equal(game.payload.players.Sputtered.damageDealt,20);
  assert.equal(game.payload.players.Mikowa.damageReceived,20);
  assert.equal(game.payload.players.Sputtered.damageByOpponent.Mikowa.dealt,20);
  assert.equal(game.payload.tracking.damage.voidFinishDamage,16.5);
  assert.equal(game.payload.tracking.damage.status,'tracked');
  assert.equal(game.payload.match.discordSubmissionId,goodJob.id);
  assert.equal(store.findJob('fixture-replay').status,'completed');
  if(invalidFirst) {
    const missing=store.findJob('missing-replay');
    assert.equal(missing.status,'invalid');assert.equal(missing.game_id,null);
    assert.equal(store.completionDM(missing.id).status,'pending');
    assert.equal(store.queue().length,0);
  }
  if(shortFirst) {
    const short=store.findJob('short-replay');assert.equal(short.status,'invalid');assert.equal(short.game_id,null);
    assert.match(short.error,/180 seconds/);assert.equal(store.completionDM(short.id).status,'pending');
    assert.equal(game.payload.match.totalDurationSec,180);
  }
  if(managed){assert.equal(upstreamConnections,2);assert.equal(store.getJob(goodJob.id).attempts,2);control.stop();}
  else {const disconnected=once(downstreamPeer,'end');viewer.end();await disconnected;}
  const exports=fs.readdirSync(config.outputDir,{recursive:true}).filter(n=>path.basename(n).startsWith('replay-'));
  assert.equal(exports.length,1,'disconnect must not create a duplicate export');
  assert.equal(externalRequests,0,'Discord mode must never call website APIs');
  assert.equal(store.games().length,1);
  console.log('DISCORD_PROXY_E2E_OK');
} catch(err) {console.error(err);process.exitCode=1;}
finally {
  clearInterval(pulse);control?.stop();
  for(const server of [upstream,local]) {
    if(!server)continue;
    for(const peer of Object.values(server.clients))peer.socket?.destroy();
    server.close();
  }
  viewer?.socket?.destroy();
  store?.close();
  fs.rmSync(dir,{recursive:true,force:true});
  process.exit(process.exitCode || 0);
}
