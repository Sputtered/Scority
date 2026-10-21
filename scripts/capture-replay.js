import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import mc from 'minecraft-protocol';
import { PacketCapture, packetText, unwrapNbt } from '../lib/packet-capture.js';
import { CaptureClient } from '../lib/capture-client.js';
import { normalizeReplayId } from '../lib/replay-id.js';

const { values } = parseArgs({ options: {
  replay: { type: 'string' }, username: { type: 'string' }, version: { type: 'string', default: '1.21.11' },
  'auth-dir': { type: 'string', default: './captures/auth' }, output: { type: 'string', default: './captures' },
  'max-seconds': { type: 'string', default: '900' }, speed: {type:'string'}, 'spectator-movement': { type: 'boolean', default: false }, help: { type: 'boolean' }
} });
if (values.help || !values.replay || !values.username) {
  console.log('node scripts/capture-replay.js --replay <id> --username <account> [--version 1.21.11] [--auth-dir ./mc-auth-cache] [--max-seconds 900]');
  console.log('Standalone local evidence capture. No Discord, scoring database, pipeline, or .env loading.');
  console.log('Console controls: use <0-8> (right-click a replay hotbar item), mark <note>, stop.');
  console.log('--spectator-movement moves the viewer 0.1 blocks and back every two minutes during playback.');
  process.exit(values.help ? 0 : 1);
}
if (!['1.8.9', '1.19.4', '1.21.11'].includes(values.version)) throw new Error('Capture adapter supports 1.8.9, 1.19.4 and 1.21.11.');
const replayId = normalizeReplayId(values.replay);
if (!replayId) throw new Error('Invalid replay ID.');
const maxSeconds = Number(values['max-seconds']);
if (!Number.isFinite(maxSeconds) || maxSeconds < 10 || maxSeconds > 5400) throw new Error('max-seconds must be between 10 and 5400.');
const modern = values.version !== '1.8.9';
const recent = values.version === '1.21.11';
const targetSpeed=values.speed==null?null:Number(values.speed);
if(targetSpeed!==null && ![1,4].includes(targetSpeed))throw new Error('--speed must be 1 or 4.');
let playbackControlAt=0,playbackControlCount=0;
const directory = path.resolve(values.output, new Date().toISOString().replace(/[:.]/g, '-') + '-' + values.version);
fs.mkdirSync(directory, { recursive: true });
const filename = path.join(directory, 'packets.jsonl.gz');
const capture = new PacketCapture({ filename, version: values.version, replayId });
console.log('Capture directory: ' + directory);
const client = mc.createClient({ host: 'mc.hypixel.net', port: 25565, version: values.version,
  Client: CaptureClient, hideErrors: true,
  username: values.username, auth: 'microsoft', profilesFolder: path.resolve(values['auth-dir']),
  clientSettings: { viewDistance: 16 }, onMsaCode: info => {
    console.log(`Minecraft sign-in: ${info.verification_uri} code ${info.user_code}`);
  }
});
let stopped = false, sentReplay = false, scheduledReplay = false, replayTimer, deadline, heartbeat, movementTimer, returnTimer, sequence = 0;
let positionRevision = 0;
let position = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }, positioned = false, lastHud = '', ticks = 0;
const consoleInput = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

async function stop(reason, failed = false) {
  if (stopped) return;
  stopped = true;
  clearTimeout(replayTimer); clearTimeout(deadline); clearInterval(heartbeat); clearInterval(movementTimer); clearTimeout(returnTimer);
  consoleInput.close();
  client.end(reason);
  try { await capture.close(reason); } catch (error) { console.error(error.message); failed = true; }
  fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({ version: values.version, replayId,
    reason, failed, sentReplay, lastReplayHud: capture.clock, packetCounts: capture.counts,
    uncompressedBytes: capture.bytes, file: filename }, null, 2));
  console.log(`Capture stopped: ${reason}`);
  process.exitCode = failed ? 1 : 0;
  setTimeout(() => client.socket?.destroy(), 1000).unref();
}

function send(name, data) {
  if (stopped || !['play', 'configuration'].includes(client.state)) return;
  capture.record({ type: 'control', state: client.state, name, data, replay: capture.clock });
  client.write(name, data);
}
consoleInput.on('line', line => {
  try {
    if (line === 'stop') void stop('Stopped by operator');
    else if (/^use [0-8]$/.test(line)) {
      if (!capture.clock) { console.log('Wait until the replay HUD is present before using replay controls.'); return; }
      send('held_item_slot', { slotId: Number(line.slice(4)) });
      if (modern) send('use_item', { hand: 0, sequence: sequence++, rotation: { x: position.yaw, y: position.pitch } });
      else send('block_place', { location: { x: -1, y: 255, z: -1 }, direction: -1, heldItem: { blockId: -1 }, cursorX: 0, cursorY: 0, cursorZ: 0 });
    } else if (line.startsWith('mark ')) capture.record({ type: 'annotation', note: line.slice(5), replay: capture.clock });
  } catch (error) { void stop(error.message, true); }
});

client.on('packet', (data, meta) => {
  if (stopped) return;
  try {
    const hud = capture.packet(meta.name, data, meta.state);
    if (meta.name === 'capture_unparsed' && capture.counts['play:capture_unparsed'] <= 3) {
      console.log('Preserved undecodable gameplay frame: ' + data.error);
    }
    if (hud) {
      const key = `${hud.state} ${hud.elapsedSec}/${hud.totalSec} ${hud.speed}x`;
      if (key !== lastHud) { console.log('HUD ' + key); lastHud = key; }
      if(targetSpeed && ['playing','paused'].includes(hud.state) && (hud.speed!==targetSpeed || hud.state==='paused') && Date.now()-playbackControlAt>=1500) {
        if(playbackControlCount++>=12){void stop('Replay speed did not reach the requested value',true);return;}
        playbackControlAt=Date.now();
        send('held_item_slot',{slotId:hud.speed===targetSpeed?4:hud.speed<targetSpeed?6:2});
        if(modern)send('use_item',{hand:0,sequence:sequence++,rotation:{x:position.yaw,y:position.pitch}});
        else send('block_place',{location:{x:-1,y:255,z:-1},direction:-1,heldItem:{blockId:-1},cursorX:0,cursorY:0,cursorZ:0});
      }
      if (hud.state === 'finished' && hud.elapsedSec >= hud.totalSec) void stop('Replay finished');
    }
    if (meta.state !== 'play') return;
    if (['chat', 'system_chat'].includes(meta.name) && data.position !== 2 && !data.overlay && !data.isActionBar) {
      const text = packetText(meta.name, data);
      if (text) console.log('Server: ' + text);
      if (/Couldn't find a replay by that UUID!/i.test(text || '')) void stop('Replay unavailable', true);
      if (/Out of sync, check your internet connection!/i.test(text || '')) void stop('Server reported an out-of-sync connection', true);
      if (/You were kicked for inactivity!/i.test(text || '')) void stop('Server kicked the viewer for inactivity', true);
      if (/Sending packets too fast!/i.test(text || '')) void stop('Server rejected the outgoing packet rate', true);
    }
    if (meta.name === 'window_items' && data.windowId === 0) {
      console.log('Hotbar: ' + JSON.stringify(data.items?.slice(36, 45).map((item, index) => {
        const value = unwrapNbt(item);
        return { slot: index, itemId: value?.blockId ?? value?.itemId, count: value?.itemCount,
          display: value?.nbtData?.display ?? value?.components?.filter(c => /name|lore/.test(c.type)) };
      })));
    }
  } catch (error) { void stop(error.message, true); }
});

client.on('position', data => {
  if (stopped) return;
  try {
    const flags = data.flags;
    positionRevision++;
    for (const [index, key] of ['x', 'y', 'z', 'yaw', 'pitch'].entries()) {
      const relative = typeof flags === 'number' ? Boolean(flags & (1 << index)) : Boolean(flags?.[key]);
      position[key] = (relative ? position[key] : 0) + data[key];
    }
    if (modern) send('teleport_confirm', { teleportId: data.teleportId });
    send('position_look', { ...position, onGround: false, flags: { onGround: false, hasHorizontalCollision: false } });
    if (recent && !positioned) send('player_loaded', {});
    positioned = true;
    if (!scheduledReplay) {
      scheduledReplay = true;
      replayTimer = setTimeout(() => {
        if (stopped || client.state !== 'play') return;
        capture.record({ type: 'control', name: 'replay_command', replayId });
        client.chat('/replay ' + replayId);
        sentReplay = true;
        console.log('Requested replay from the beginning: ' + replayId);
      }, 5000);
    }
  } catch (error) { void stop(error.message, true); }
});
client.on('login', () => {
  console.log('Joined as ' + client.username);
  if (!recent) send('settings', { locale: 'en_US', viewDistance: 16, chatFlags: 0, chatColors: true,
    skinParts: 127, mainHand: 1, enableTextFiltering: false, enableServerListing: true });
  client.writeChannel(modern ? 'minecraft:brand' : 'MC|Brand', 'Scority');
});
client.registerChannel(modern ? 'minecraft:brand' : 'MC|Brand', ['string', []]);
client.on('state', state => {
  if (state === 'configuration') client.writeChannel('minecraft:brand', 'Scority');
});
client.on('chunk_batch_finished', () => { if (recent) send('chunk_batch_received', { chunksPerTick: 10 }); });
client.on('ping', data => { if (modern) send('pong', { id: data.id }); });
client.on('transaction', data => { if (!modern) send('transaction', { windowId: data.windowId, action: data.action, accepted: true }); });
client.on('kick_disconnect', data => { console.log('Disconnected: ' + JSON.stringify(unwrapNbt(data.reason))); });
client.on('disconnect', data => { console.log('Disconnected: ' + JSON.stringify(unwrapNbt(data.reason))); });
client.on('error', error => { void stop(error.message, true); });
client.on('end', reason => { if (!stopped) void stop('Connection ended: ' + reason, true); });
// stationary viewers need one position reminder per second
heartbeat = setInterval(() => {
  if (positioned && !stopped && client.state === 'play') {
    try {
      if (ticks++ % 20 === 0) client.write('position', { x: position.x, y: position.y, z: position.z, onGround: false,
        flags: { onGround: false, hasHorizontalCollision: false } });
      else if (!modern) client.write('flying', { onGround: false });
      if (recent) client.write('tick_end', {});
    } catch (error) { void stop(error.message, true); }
  }
}, 50);
if (values['spectator-movement']) movementTimer = setInterval(() => {
  if (stopped || !positioned || client.state !== 'play' || capture.clock?.state !== 'playing') return;
  const original = { ...position }, revision = positionRevision;
  position = { ...position, x: position.x + 0.1 };
  send('position_look', { ...position, onGround: false, flags: { onGround: false, hasHorizontalCollision: false } });
  console.log('Spectator moved 0.1 blocks; replay speed and time unchanged.');
  returnTimer = setTimeout(() => {
    if (stopped || client.state !== 'play' || positionRevision !== revision) return;
    position = original;
    send('position_look', { ...position, onGround: false, flags: { onGround: false, hasHorizontalCollision: false } });
  }, 1000);
}, 120_000);
deadline = setTimeout(() => { void stop('Capture time limit reached'); }, maxSeconds * 1000);
process.once('SIGINT', () => { void stop('SIGINT'); });
process.once('SIGTERM', () => { void stop('SIGTERM'); });
