import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {once} from 'node:events';
import mc from 'minecraft-protocol';
import config from '../../config.js';
import {ReplayStore,ADMIN_ID} from '../../lib/discord/store.js';
import {RecorderPool} from '../../lib/discord/recorder-pool.js';
import {BotControl} from '../../lib/discord/control.js';
import {setDiscordRuntime} from '../../lib/discord/runtime.js';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'proxy-pool-'));
const createServer=mc.createServer,createClient=mc.createClient;
let upstream,local,store,control,timer;
try{
  config.outputDir=path.join(dir,'output');config.authCacheDir=path.join(dir,'auth');
  config.automation={...config.automation,postSpawnDelayMs:0,postLobbyDelayMs:0,postCommandDelayMs:0,betweenReplaysDelayMs:0,movementIntervalMs:0,rightClickCount:0,speedSlotClickCount:0};
  upstream=createServer({'online-mode':false,host:'127.0.0.1',port:0,version:'1.8.9',keepAlive:false});await once(upstream,'listening');
  const pending=[],sessions=[],options=[];let sawParallel=false,kicked=false;
  const finish=({peer,replay})=>{
    const names=replay==='first'?['FirstRed','FirstGreen']:['SecondRed','SecondGreen'];
    const chat=(text,position=0)=>peer.write('chat',{message:JSON.stringify({text}),position});
    chat(`§a${names[1]} §7was killed by §c${names[0]}§7. FINAL KILL!`);
    for(let time=4;time<180;time+=4)chat(`§aPlaying §e${String(Math.floor(time/60)).padStart(2,'0')}:${String(time%60).padStart(2,'0')} / 03:00 §64.0x`,2);
    chat('§cFinished §e03:00 / 03:00 §64.0x',2);
  };
  upstream.on('login',peer=>{
    sessions.push(peer);
    peer.write('login',{entityId:sessions.length,gameMode:0,dimension:0,difficulty:0,maxPlayers:1,levelType:'default',reducedDebugInfo:false});
    peer.write('position',{x:0,y:64,z:0,yaw:0,pitch:0,flags:0});
    peer.on('chat',({message})=>{
      if(!message.startsWith('/replay '))return;
      const replay=message.slice(8);
      peer.write('chat',{message:JSON.stringify({text:'§aPlaying §e00:00 / 03:00 §64.0x'}),position:2});
      if(kicked){finish({peer,replay});return;}
      pending.push({peer,replay});
      if(pending.length===2){
        assert.equal(store.queue().filter(j=>j.status==='recording').length,2);
        assert.notEqual(pending[0].replay,pending[1].replay);sawParallel=true;kicked=true;
        pending[0].peer.end(JSON.stringify({text:'Test reconnect'}));finish(pending[1]);
      }
    });
  });
  mc.createClient=opts=>{
    options.push({username:opts.username,cache:opts.profilesFolder});
    return createClient({host:'127.0.0.1',port:upstream.socketServer.address().port,version:'1.8.9',auth:'offline',username:opts.username,keepAlive:false});
  };
  mc.createServer=opts=>(local=createServer({...opts,'online-mode':false,host:'127.0.0.1',port:0,keepAlive:false}));
  store=new ReplayStore(':memory:');store.submit(ADMIN_ID,'first');store.submit(ADMIN_ID,'second');
  const pool=new RecorderPool(store,[{id:'one',label:'One',username:'FirstAccount',authCacheDir:path.join(dir,'one')},{id:'two',label:'Two',username:'SecondAccount',authCacheDir:path.join(dir,'two')}]);
  control=new BotControl(store,pool);control.data.save(ADMIN_ID,control.data.settings().version,{'connection.retryDelayMs':1000,'connection.maxRetryDelayMs':1000});
  control.values=control.data.settings().values;control.apply();
  setDiscordRuntime({store,recorder:pool,control});await import('../../proxy.js');
  timer=setInterval(()=>{control.pulse();void pool.tick();},20);
  const deadline=Date.now()+8000;
  while((store.games().length<2||sessions.length<3)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(store.games().length,2);assert.equal(sawParallel,true);assert.equal(sessions.length,3);
  for(const [replay,names]of [['first',['FirstGreen','FirstRed']],['second',['SecondGreen','SecondRed']]]){
    const job=store.findJob(replay),game=store.findGame(replay);
    assert.equal(job.status,'completed');assert.deepEqual(Object.keys(game.payload.players).sort(),names);
    assert.equal(game.payload.killFeed.length,1);assert.equal(game.payload.match.discordSubmissionId,job.id);
  }
  assert.deepEqual(store.jobs().map(j=>j.attempts).sort(),[1,2]);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM completion_dms').get().n,2);
  assert.equal(new Set(options.map(o=>o.cache)).size,2);assert.equal(new Set(options.map(o=>o.username)).size,2);
  control.stop();
  assert.equal(fs.readdirSync(config.outputDir,{recursive:true}).filter(p=>path.basename(p).startsWith('replay-')).length,2);
  console.log('DISCORD_PROXY_POOL_OK');
}catch(error){console.error(error);process.exitCode=1;}
finally{
  clearInterval(timer);control?.stop();
  for(const server of [upstream,local])if(server){for(const peer of Object.values(server.clients))peer.socket?.destroy();server.close();}
  store?.close();fs.rmSync(dir,{recursive:true,force:true});process.exit(process.exitCode||0);
}
