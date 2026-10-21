import fs from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { parseActionBar } from './actionbar-parser.js';
import { flattenToText } from './death-parser.js';

// exclude authentication and credentials
const PLAY_PACKETS = /^(?:login|respawn|chat|system_chat|player_chat|action_bar|title|player_info|player_info_update|player_info_remove|player_remove|player_list_item|named_entity_spawn|spawn_entity.*|entity_.*|rel_entity_move|animation|damage_event|hurt_animation|collect|update_health|scoreboard_.*|position|map_chunk.*|unload_chunk|block_.*|multi_block_change|tile_entity_data|window_items|set_slot|open_window|close_window|held_item_slot|update_time|world_event|world_particles|sound_effect|named_sound_effect|transaction|ping|kick_disconnect)$/;

export function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (value?.type === 'Buffer' && Array.isArray(value.data)) return { $buffer: Buffer.from(value.data).toString('base64') };
  return value;
}

export function unwrapNbt(value) {
  if (Array.isArray(value)) return value.map(unwrapNbt);
  if (!value || typeof value !== 'object') return value;
  if (typeof value.type === 'string' && Object.hasOwn(value, 'value')) return unwrapNbt(value.value);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, unwrapNbt(entry)]));
}

export function packetText(name, data) {
  const raw = name === 'action_bar' ? data.text : data.message ?? data.content ?? data.chatContent ?? data.text;
  if (raw == null) return null;
  let component = unwrapNbt(raw);
  if (typeof component === 'string') {
    try { component = JSON.parse(component); } catch {  }
  }
  return flattenToText(component);
}

export class PacketCapture {
  constructor({ filename, version, replayId, now = () => performance.now(), maxBytes = 512 * 1024 * 1024 }) {
    this.now = now;
    this.started = now();
    this.sequence = 0;
    this.bytes = 0;
    this.maxBytes = maxBytes;
    this.counts = {};
    this.clock = null;
    this.epoch = 0;
    this.error = null;
    this.closed = false;
    this.gzip = createGzip();
    this.finished = pipeline(this.gzip, fs.createWriteStream(filename, { flags: 'wx' }));
    this.finished.catch(error => { this.error = error; });
    this.record({ type: 'capture', schema: 1, version, replayId, startedAt: new Date().toISOString(),
      timing: 'Replay time is the last observed HUD sample, not an interpolated hit timestamp.' });
  }

  record(value) {
    if (this.error) throw this.error;
    if (this.closed) throw new Error('Capture is already closed.');
    const line = JSON.stringify({ sequence: this.sequence++, receivedMs: this.now() - this.started, ...value }, jsonReplacer) + '\n';
    this.bytes += Buffer.byteLength(line);
    if (this.bytes > this.maxBytes) throw new Error('Capture reached its uncompressed size limit.');
    if (this.gzip.writableLength > 16 * 1024 * 1024) throw new Error('Capture disk writer cannot keep up; stopping instead of dropping packets.');
    this.gzip.write(line);
  }

  packet(name, data, state = 'play') {
    if (state !== 'play' && !(state === 'configuration' && ['registry_data', 'ping', 'finish_configuration', 'select_known_packs', 'feature_flags'].includes(name))) return null;
    this.counts[`${state}:${name}`] = (this.counts[`${state}:${name}`] || 0) + 1;
    if (state === 'play' && !PLAY_PACKETS.test(name) && !['capture_unparsed', 'sync_entity_position', 'teams'].includes(name)) return null;
    let hud = null;
    if (name === 'action_bar' || (name === 'chat' && data.position === 2) || (name === 'system_chat' && (data.overlay || data.isActionBar))) {
      hud = parseActionBar(packetText(name, data));
      if (hud) {
        if (this.clock && (hud.elapsedSec < this.clock.elapsedSec || hud.totalSec !== this.clock.totalSec)) this.epoch++;
        this.clock = { ...hud, epoch: this.epoch, observedAtMs: this.now() - this.started };
      }
    }
    this.record({ type: 'packet', state, name, replay: this.clock ? { ...this.clock } : null, data });
    // world changes invalidate replay time
    if (name === 'respawn' || name === 'login') { this.clock = null; this.epoch++; }
    return hud;
  }

  async close(reason) {
    if (!this.closed) {
      if (!this.error && this.bytes < this.maxBytes) {
        try { this.record({ type: 'end', reason, packetCounts: this.counts }); } catch (error) { this.error = error; }
      }
      this.closed = true;
      this.gzip.end();
    }
    await this.finished;
  }
}
