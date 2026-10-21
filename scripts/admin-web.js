import path from 'node:path';
import {ReplayStore} from '../lib/discord/store.js';
import {startAdminServer} from '../lib/web/server.js';
const store=new ReplayStore(path.resolve(process.env.REPLAY_DATABASE || './data/replays.sqlite'));
try{
  const web=await startAdminServer({store,key:process.env.SCORITY_WEB_KEY,host:process.env.SCORITY_WEB_HOST || '127.0.0.1',
    port:Number(process.env.SCORITY_WEB_PORT || 3080),origin:process.env.SCORITY_WEB_ORIGIN,trustProxy:process.env.SCORITY_WEB_PROXY==='1'});
  console.log(`Scority admin listening at ${web.origin}`);
  let stopping=false;
  const stop=async()=>{if(stopping)return;stopping=true;await web.close();store.close();};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
}catch(error){store.close();console.error(error.message);process.exitCode=1;}
