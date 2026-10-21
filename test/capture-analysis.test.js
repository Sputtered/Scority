import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureAnalysis, chestDistance } from '../lib/capture-analysis.js';
import {Vec3} from 'vec3';

function scenario() {
  const analyzer = new CaptureAnalysis('1.21.11');
  let sequence = 0;
  const packet = (name, data, elapsedSec = 0, epoch = 1) => analyzer.observe({ type: 'packet',
    name, data, sequence: sequence++, replay: { state: 'playing', elapsedSec, totalSec: 120, speed: 1, epoch } });
  packet('player_info', { data: [{ uuid: 'player-a', player: { name: 'Alice' } }, { uuid: 'player-b', player: { name: 'Bob' } }] });
  const spawnPlayer = (id = 1) => packet('spawn_entity', { entityId: id, objectUUID: id === 1 ? 'player-a' : 'player-b',
    type: analyzer.registry.entitiesByName.player.id, x: 0.5, y: 65.5, z: 0.5 });
  const health = (value, time, epoch = 1) => packet('entity_metadata', { entityId: 1,
    metadata: [{ key: 9, type: 'float', value }] }, time, epoch);
  return { analyzer, packet, spawnPlayer, health };
}

test('legacy live bulk chunks and partial section updates preserve the correct ender chests',()=>{
  const analyzer=new CaptureAnalysis('1.8.9'),chunk=new analyzer.Chunk();
  chunk.setBlockType(new Vec3(1,65,2),130);chunk.setBlockType(new Vec3(3,81,4),130);
  const send=(name,data)=>analyzer.observe({type:'packet',name,data,replay:{state:'playing',elapsedSec:0,speed:1,epoch:0}});
  send('map_chunk_bulk',{skyLightSent:true,meta:[{x:-1,z:0,bitMap:48},{x:1,z:0,bitMap:48}],data:Buffer.concat([chunk.dump(48),chunk.dump(48)])});
  assert.equal(analyzer.chests.size,4);
  assert.ok(analyzer.chests.has('-15,65,2'));assert.ok(analyzer.chests.has('19,81,4'));
  const empty=new analyzer.Chunk();
  send('map_chunk',{x:-1,z:0,bitMap:16,groundUp:false,chunkData:empty.dump(16).subarray(0,-256)});
  assert.equal(analyzer.chests.size,3);assert.ok(!analyzer.chests.has('-15,65,2'));
  assert.ok(analyzer.chests.has('-13,81,4'));assert.deepEqual(analyzer.chunkErrors,[]);
  send('map_chunk',{x:-1,z:0,bitMap:0,groundUp:true,chunkData:Buffer.alloc(0)});
  assert.equal(analyzer.chests.size,2);assert.deepEqual(analyzer.chunkErrors,[]);
});

test('health evidence separates fractional losses, healing, spawn resets and rewinds', () => {
  const { analyzer, packet, spawnPlayer, health } = scenario();
  spawnPlayer(); health(20, 0); health(16.5, 1); health(17.5, 2); health(15, 3);
  packet('system_chat', { content: JSON.stringify({ text: 'Alice was killed by Bob.' }), isActionBar: false }, 4);
  spawnPlayer(); health(20, 5); health(18, 6);
  health(12, 1, 2);
  const result = analyzer.result();
  assert.deepEqual(result.health.changes.map(c => c.healthLoss), [3.5, 0, 2.5, 2]);
  assert.equal(result.health.changes.reduce((sum, c) => sum + c.healing, 0), 1);
  assert.equal(result.deaths[0].killer, 'Bob');
  assert.equal(result.damageEvents.length, 0);
});

test('resource evidence preserves both packet and metadata quantities without guessing throw ownership', () => {
  const { analyzer, packet, spawnPlayer } = scenario();
  spawnPlayer();
  packet('spawn_entity', { entityId: 3, objectUUID: 'item', type: analyzer.registry.entitiesByName.item.id,
    x: 1, y: 66, z: 1, objectData: 0 });
  packet('entity_metadata', { entityId: 3, metadata: [{ key: 8, type: 'item_stack', value: {
    itemId: analyzer.registry.itemsByName.diamond.id, itemCount: 4 } }] });
  packet('collect', { collectedEntityId: 3, collectorEntityId: 1, pickupItemCount: 2 });
  packet('rel_entity_move', { entityId: 1, dX: 4096, dY: 0, dZ: 0 });
  packet('collect', { collectedEntityId: 999, collectorEntityId: 1, pickupItemCount: 1 });
  const result = analyzer.result();
  assert.equal(result.resources.pickups[0].collector, 'Alice');
  assert.equal(result.resources.pickups[0].collectorPosition.x, 0.5, 'later movement must not rewrite the pickup evidence');
  assert.equal(result.resources.quantityDisagreements.length, 1);
  assert.equal(result.resources.pickupCount, 1, 'an unseen item cannot be assumed to be a tracked resource');
  assert.equal(result.resources.collections.unknownItem, 1);
  assert.equal(result.resources.unresolvedCollections[0].collectedEntityId, 999);
  assert.equal(result.resources.spawns[0].nearbyPlayers[0].player, 'Alice');
  assert.match(result.resources.spawns[0].attribution, /No thrower assigned/);
});

test('decoded ender-chest chunks and modern teleports support inclusive 5-block visits without tick duplicates', () => {
  const { analyzer, packet, spawnPlayer } = scenario();
  const chunk = new analyzer.Chunk({ minY: 0, worldHeight: 256 });
  chunk.setBlockStateId({ x: 0, y: 65, z: 0 }, analyzer.registry.blocksByName.ender_chest.defaultState);
  packet('map_chunk', { x: -1, z: 0, chunkData: { $buffer: chunk.dump().toString('base64') } });
  spawnPlayer();
  const move = x => packet('sync_entity_position', { entityId: 1, x, y: 65.5, z: 0.5 });
  move(-10.49); // 5.01 blocks from center
  assert.equal(analyzer.chestVisits.length, 0);
  move(-10.5); move(-11); move(-12);
  assert.equal(analyzer.chestVisits.length, 1);
  assert.equal(analyzer.chestVisits[0].distance, 5);
  move(-9); move(-12);
  assert.equal(analyzer.chestVisits.length, 2);
  assert.equal(chestDistance({ x: 0.5, y: 5.5, z: 0.5 }, { x: 0, y: 0, z: 0 }), 5);
  assert.deepEqual(analyzer.chunkErrors, []);
});

test('ending a partial capture and loading a lobby do not imply replay completion or replace replay chests', () => {
  const { analyzer, packet } = scenario();
  const chest = { x: 17, y: 65, z: 73 };
  packet('block_change', { location: chest, type: analyzer.registry.blocksByName.ender_chest.defaultState }, 318);
  packet('respawn', {}, 318);
  analyzer.observe({ type: 'packet', name: 'block_change', replay: null,
    data: { location: { x: 0, y: 0, z: 0 }, type: analyzer.registry.blocksByName.ender_chest.defaultState } });
  analyzer.observe({ type: 'end', reason: 'Stopped by operator' });
  assert.deepEqual(analyzer.result().enderChests, [chest]);
  assert.equal(analyzer.result().captureEnded, true);
  assert.equal(analyzer.result().replayFinished, false);
});

test('replay team suffix restores a truncated player name for death resets without accepting health decorations', () => {
  const { analyzer, packet, spawnPlayer, health } = scenario();
  packet('player_info', { data: [{ uuid: 'player-a', player: { name: 'CharlieJohnson\u00a7r' } }] });
  packet('teams', { team: 'green', mode: 'add', prefix: { text: '\u00a7a' }, suffix: { text: '\u00a7a8' }, players: [] });
  packet('teams', { team: 'green', mode: 'join', players: ['CharlieJohnson\u00a7r'] });
  spawnPlayer(); health(20, 0); health(18, 1);
  packet('system_chat', { content: JSON.stringify({ text: 'CharlieJohnson8 was killed by Bob.' }), isActionBar: false }, 2);
  health(20, 3); health(17, 4);
  assert.deepEqual(analyzer.result().health.changes.map(c => [c.player, c.healthLoss, c.healing]),
    [['CharlieJohnson8', 2, 0], ['CharlieJohnson8', 3, 0]]);
  packet('teams', { team: 'green', mode: 'change', suffix: { text: ' 17 HP' } });
  assert.equal(analyzer.playerName(analyzer.entities.get(1)), 'CharlieJohnson');
});

test('legacy scoreboard teams restore truncated NPC names and remove stale membership', () => {
  const analyzer = new CaptureAnalysis('1.8.9');
  const send = (name, data) => analyzer.observe({ type: 'packet', name, data });
  const raw = 'CharlieJohnson\u00a7r';
  send('player_info', { data: [{ UUID: 'charlie', name: raw }] });
  send('scoreboard_team', { team: 'green', mode: 0, prefix: '\u00a7a', suffix: '\u00a7a8', players: [] });
  send('scoreboard_team', { team: 'green', mode: 3, players: [raw] });
  assert.equal(analyzer.playerName({ uuid: 'charlie' }), 'CharlieJohnson8');
  send('scoreboard_team', { team: 'green', mode: 2, suffix: '\u00a7a9' });
  assert.equal(analyzer.playerName({ uuid: 'charlie' }), 'CharlieJohnson9');
  send('scoreboard_team', { team: 'green', mode: 4, players: [raw] });
  assert.equal(analyzer.playerName({ uuid: 'charlie' }), 'CharlieJohnson');
});
