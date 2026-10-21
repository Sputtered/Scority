import path from 'node:path';
import { ReplayStore, ADMIN_ID } from './lib/discord/store.js';
import { RecorderBridge } from './lib/discord/recorder.js';
import { setDiscordRuntime } from './lib/discord/runtime.js';
import { startBot } from './lib/discord/bot.js';
import { acquireRecorderLock } from './lib/discord/lock.js';
import { BotControl } from './lib/discord/control.js';
import { RecorderPool } from './lib/discord/recorder-pool.js';
import { recorderAccounts } from './lib/recorder-accounts.js';
import config from './config.js';

if (!/^[1-9]\d{16,19}$/.test(ADMIN_ID)) {
  console.error('Set DISCORD_OWNER_ID in .env to your Discord user ID. See START-HERE.md.');
  process.exit(1);
}
if (!(process.env.MINECRAFT_USERNAME || '').trim() && !(process.env.MINECRAFT_ACCOUNTS || '').trim()) {
  console.error('Set MINECRAFT_USERNAME or MINECRAFT_ACCOUNTS in .env. See START-HERE.md.');
  process.exit(1);
}
const token=process.env.DISCORD_TOKEN;
if (!token) {
  console.error('Set DISCORD_TOKEN in .env before starting. See README.md → Discord setup.');
  process.exit(1);
}
const database=path.resolve(process.env.REPLAY_DATABASE || './data/replays.sqlite');
let release,store,client,timer,recorderTimer,heartbeat;
try {
  release=acquireRecorderLock(`${database}.lock`);
  process.once('exit',()=>release());
  store=new ReplayStore(database);
  const recovered=store.recover();
  if (recovered) console.log(`[discord] Requeued ${recovered} interrupted recording(s).`);
  const accounts=recorderAccounts(process.env.MINECRAFT_ACCOUNTS,config.authCacheDir);
  const recorder=accounts.length?new RecorderPool(store,accounts):new RecorderBridge(store);
  const control=new BotControl(store,recorder);
  client=await startBot({token,store,recorder,control});
  setDiscordRuntime({store,recorder,control});
  await import('./proxy.js');
  let ticking=false,recordingTick=false;
  timer=setInterval(async()=>{
    if (ticking) return;
    ticking=true;
    try { await control.tick(); } catch (err) { console.error(`[control] Command tick failed: ${err.message}`); }
    finally { ticking=false; }
  },1000);
  recorderTimer=setInterval(async()=>{
    if(recordingTick)return;
    recordingTick=true;
    try{await recorder.tick();control.recordProcessor('recorder');}
    catch(error){control.recordProcessor('recorder',error);console.error(`[recorder] Queue tick failed: ${error.message}`);}
    finally{recordingTick=false;}
  },1000);
  heartbeat=setInterval(()=>{try{control.pulse();}catch(error){console.error(`[control] ${error.message}`);}},1000);
  let stopping=false;
  const stop=async()=>{
    if (stopping) return; stopping=true;
    clearInterval(timer);clearInterval(recorderTimer);clearInterval(heartbeat); control.stop(); await client.destroy();
    // finish socket shutdown before closing storage
    process.once('beforeExit',()=>{ store.close(); release(); });
  };
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
} catch (err) {
  clearInterval(timer);clearInterval(recorderTimer);clearInterval(heartbeat); await client?.destroy(); store?.close(); release?.();
  console.error(`Could not start Scority: ${err.message}`);
  process.exitCode=1;
}
