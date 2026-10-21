import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import mc from 'minecraft-protocol';
import { PacketCapture, packetText } from '../lib/packet-capture.js';
import { CaptureClient } from '../lib/capture-client.js';

async function fixture(t, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scority-capture-'));
  const filename = path.join(directory, 'packets.jsonl.gz');
  let milliseconds = 0;
  const capture = new PacketCapture({ filename, version: '1.21.11', replayId: 'fixture', now: () => milliseconds });
  t.after(async () => { await capture.close('test cleanup'); fs.rmSync(directory, { recursive: true, force: true }); });
  await run(capture, time => { milliseconds = time; });
  await capture.close('test complete');
  return gunzipSync(fs.readFileSync(filename)).toString().trim().split('\n').map(JSON.parse);
}

test('capture keeps full metadata, binary chunks and large integers while excluding authentication', async t => {
  const rows = await fixture(t, capture => {
    capture.packet('encryption_begin', { serverId: 'secret' }, 'login');
    capture.packet('success', { accessToken: 'secret' }, 'login');
    capture.packet('entity_metadata', { entityId: 17, metadata: [{ key: 9, type: 'float', value: 16.5 }] });
    capture.packet('sync_entity_position', { entityId: 17, x: 1.25, y: 65, z: -17 });
    capture.packet('teams', { team: 'red', mode: 0 });
    capture.packet('map_chunk', { chunkData: Buffer.from([0, 255, 42]), mask: 9007199254740993n });
  });
  assert.ok(!JSON.stringify(rows).includes('secret'));
  assert.equal(rows.find(r => r.name === 'entity_metadata').data.metadata[0].value, 16.5);
  assert.equal(rows.find(r => r.name === 'sync_entity_position').data.x, 1.25);
  assert.equal(rows.find(r => r.name === 'teams').data.team, 'red');
  const chunk = rows.find(r => r.name === 'map_chunk').data;
  assert.deepEqual(Buffer.from(chunk.chunkData.$buffer, 'base64'), Buffer.from([0, 255, 42]));
  assert.equal(chunk.mask.$bigint, '9007199254740993');
});

test('capture uses observed replay HUD time, separates rewinds and clears time on world changes', async t => {
  const rows = await fixture(t, (capture, time) => {
    const hud = text => capture.packet('chat', { position: 2, message: JSON.stringify({ text }) });
    hud('Playing 00:10 / 03:00 1.0x');
    time(550); capture.packet('animation', { entityId: 1, animation: 1 });
    time(5000); hud('Paused 00:10 / 03:00 1.0x');
    capture.packet('collect', { collectedEntityId: 3, collectorEntityId: 1 });
    hud('Playing 00:05 / 03:00 2.0x');
    capture.packet('damage_event', { entityId: 1, sourceCauseId: 0, sourceDirectId: 0 });
    capture.packet('respawn', {});
    capture.packet('entity_metadata', { entityId: 1, metadata: [] });
  });
  const swing = rows.find(r => r.name === 'animation');
  assert.equal(swing.replay.elapsedSec, 10);
  assert.equal(swing.replay.observedAtMs, 0);
  assert.equal(swing.receivedMs, 550);
  assert.equal(rows.find(r => r.name === 'collect').replay.state, 'paused');
  assert.equal(rows.find(r => r.name === 'damage_event').replay.epoch, 1);
  assert.equal(rows.find(r => r.name === 'entity_metadata').replay, null);
});

test('modern typed NBT action bars decode without discarding their raw packet', async t => {
  const text = { type: 'compound', value: { text: { type: 'string', value: '' }, extra: {
    type: 'list', value: { type: 'compound', value: [{ text: { type: 'string', value: 'Playing 00:03 / 03:00 1.0x' } }] }
  } } };
  assert.equal(packetText('action_bar', { text }), 'Playing 00:03 / 03:00 1.0x');
  const rows = await fixture(t, capture => capture.packet('action_bar', { text }));
  const row = rows.find(r => r.name === 'action_bar');
  assert.equal(row.replay.elapsedSec, 3);
  assert.deepEqual(row.data.text, text);
});

test('Hypixel modern system_chat isActionBar marks the observed replay clock', async t => {
  const rows = await fixture(t, capture => capture.packet('system_chat', { isActionBar: true,
    content: { type: 'compound', value: { text: { type: 'string', value: 'Playing 00:12 / 08:57 1.0x' } } } }));
  assert.equal(rows.find(r => r.name === 'system_chat').replay.elapsedSec, 12);
});

function roundTrip(version, name, params) {
  const serializer = mc.createSerializer({ isServer: true, version, state: 'play' });
  const decoder = mc.createDeserializer({ isServer: false, version, state: 'play' });
  return decoder.parsePacketBuffer(serializer.createPacketBuffer({ name, params })).data.params;
}

test('installed protocol codecs preserve populated and empty modern damage source fields', () => {
  for (const [sourceCauseId, sourceDirectId] of [[0, 0], [18, 42]]) {
    const data = { entityId: 9, sourceTypeId: 2, sourceCauseId, sourceDirectId, sourcePosition: undefined };
    assert.deepEqual(roundTrip('1.21.11', 'damage_event', data), data);
  }
});

test('legacy collection has no quantity field while the modern codec can carry partial-stack counts', () => {
  const legacy = roundTrip('1.8.9', 'collect', { collectedEntityId: 11, collectorEntityId: 9 });
  assert.deepEqual(legacy, { collectedEntityId: 11, collectorEntityId: 9 });
  const modern = roundTrip('1.21.11', 'collect', { ...legacy, pickupItemCount: 2 });
  assert.equal(modern.pickupItemCount, 2);
});

test('diagnostic decoder preserves malformed frames and can parse the next valid packet', () => {
  const client = new CaptureClient(false, '1.21.11');
  client.state = 'play';
  const malformed = Buffer.from([0x19]);
  const failed = client.deserializer.parsePacketBuffer(malformed);
  assert.equal(failed.data.name, 'capture_unparsed');
  assert.deepEqual(failed.data.params.raw, malformed);
  assert.ok(failed.data.params.error);
  const serializer = mc.createSerializer({ isServer: true, version: '1.21.11', state: 'play' });
  const params = { collectedEntityId: 11, collectorEntityId: 9, pickupItemCount: 2 };
  assert.deepEqual(client.deserializer.parsePacketBuffer(serializer.createPacketBuffer({ name: 'collect', params })).data.params, params);
});
