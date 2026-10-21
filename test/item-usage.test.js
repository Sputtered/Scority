import test from 'node:test';
import assert from 'node:assert/strict';
import {ReplayStats} from '../lib/replay-stats.js';
import {ITEM_USAGE_FIELDS} from '../lib/item-usage.js';

function fixture({version='1.8.9', parseDeaths=true, paused=false}={}) {
  const tracker = new ReplayStats(version, {parseDeaths});
  let sequence = 0, elapsedSec = 0;
  const hud = (state='playing', t=elapsedSec) => {
    elapsedSec = t;
    tracker.setPlayback({state, elapsedSec, totalSec:60, speed:1});
  };
  hud(paused ? 'paused' : 'playing');
  const packet = (name, data) => tracker.observe(name, data, 'play', sequence++);
  const spawn = (id=1, name='Alice', currentItem=0) => {
    packet('player_info', {data:[{uuid:name, name}]});
    if (version === '1.8.9') packet('named_entity_spawn', {entityId:id, playerUUID:name, x:0, y:64*32, z:0, currentItem});
    else packet('spawn_entity', {entityId:id, objectUUID:name,
      type:tracker.world.registry.entitiesByName.player.id, x:0, y:64, z:0});
  };
  const equip = (name, id=1) => packet('entity_equipment', {entityId:id, slot:0,
    item:name ? {blockId:tracker.world.registry.itemsByName[name].id, itemCount:1} : {blockId:-1}});
  const finishUse = (id=1) => packet('entity_status', {entityId:id, entityStatus:9});
  const health = value => packet('entity_metadata', {entityId:1, metadata:[{key:6, value}]});
  const death = (name='Alice') => packet('chat', {message:JSON.stringify({text:`${name} fell into the void.`}), position:0});
  const finish = () => {hud('finished'); return tracker.result();};
  const advance = () => hud('playing', elapsedSec+1);
  spawn();
  return {tracker, packet, hud, spawn, equip, finishUse, health, death, finish, advance};
}

test('completed golden apple use counts, while potion, cancelled use, switching, and animations do not', () => {
  const f=fixture();
  f.equip('golden_apple');
  f.packet('entity_metadata', {entityId:1, metadata:[{key:0, value:16}]});
  f.packet('entity_metadata', {entityId:1, metadata:[{key:0, value:0}]});
  f.equip('iron_sword');
  f.finishUse();
  f.equip('potion');
  f.finishUse();
  f.equip('golden_apple');
  f.packet('animation', {entityId:1, animation:0});
  f.finishUse();
  f.finishUse();
  const result=f.finish();
  assert.equal(result.players.Alice.goldenApplesEaten, 2);
  assert.equal(result.tracking.itemUsage.status, 'tracked');
  assert.equal(result.tracking.itemUsageEvents.filter(e=>e.field==='goldenApplesEaten').length, 2);
});

test('each tool counts once per life, across repeated switches and equipment refreshes', () => {
  const f=fixture();
  for(let i=0;i<3;i++) for(const item of ['iron_sword','wooden_sword','golden_pickaxe','iron_axe']) f.equip(item);
  const player=f.finish().players.Alice;
  assert.deepEqual(ITEM_USAGE_FIELDS.map(field=>player[field]), [0,1,1,1,0]);
});

test('milk buckets count once per life across switches and repeated drinking', () => {
  const f=fixture();
  for(let i=0;i<3;i++) {
    f.equip('milk_bucket');
    f.finishUse();
    f.equip('bucket');
    f.equip('golden_apple');
  }
  f.death();
  f.spawn();
  f.equip('milk_bucket');
  f.finishUse();
  const player=f.finish().players.Alice;
  assert.equal(player.milkBucketLives, 2);
  assert.equal(player.goldenApplesEaten, 0);
});

test('visibility destruction and same-player respawns preserve the current life', () => {
  const f=fixture();
  f.equip('iron_sword');
  f.packet('entity_destroy', {entityIds:[1]});
  f.spawn(2);
  f.equip('iron_sword',2);
  f.spawn(2);
  f.equip('iron_sword',2);
  assert.equal(f.finish().players.Alice.ironSwordLives, 1);
});

test('a recorded death and a new entity count another tool life, with duplicate death ignored', () => {
  const f=fixture();
  f.equip('iron_sword');
  f.death();
  f.death();
  f.equip('iron_axe');
  f.packet('entity_destroy', {entityIds:[1]});
  f.spawn();
  f.equip('iron_sword');
  const result=f.finish();
  assert.equal(result.players.Alice.ironSwordLives, 2);
  assert.equal(result.players.Alice.ironAxeLives, 0);
  assert.deepEqual(result.tracking.itemUsageEvents.map(e=>e.life), [1,2]);
});

test('post-death health cleanup cannot reopen a life; a new spawn may reuse its entity ID', () => {
  const f=fixture();
  f.equip('iron_sword');
  f.health(20);
  f.death();
  f.equip('iron_sword');
  f.health(0);
  f.health(20);
  f.equip('iron_sword');
  f.equip('iron_axe');
  assert.equal(f.tracker.itemUsage.events.filter(e=>e.field==='ironSwordLives').length,1);
  assert.equal(f.tracker.itemUsage.events.filter(e=>e.field==='ironAxeLives').length,0);
  f.packet('entity_destroy',{entityIds:[1]});
  f.spawn();
  f.equip('iron_sword');
  assert.equal(f.finish().players.Alice.ironSwordLives, 2);
});

test('lingering dead entities cannot credit gear or apples after a new life spawns', () => {
  const f=fixture();
  f.equip('iron_sword');
  f.death();
  f.spawn(2);
  f.equip('milk_bucket',2);
  f.equip('iron_axe',1);
  f.equip('golden_apple',1);
  f.finishUse(1);
  f.equip('iron_sword',2);
  const player=f.finish().players.Alice;
  assert.equal(player.ironSwordLives,2);
  assert.equal(player.milkBucketLives,1);
  assert.equal(player.ironAxeLives,0);
  assert.equal(player.goldenApplesEaten,0);
});

test('external Match deaths split lives when ReplayStats parseDeaths is disabled', () => {
  const f=fixture({parseDeaths:false});
  f.equip('golden_pickaxe');
  f.death();
  f.tracker.recordDeath({victim:'Alice', raw:'Alice fell into the void.'});
  f.spawn();
  f.equip('golden_pickaxe');
  assert.equal(f.finish().players.Alice.goldenPickaxeLives, 2);
});

test('paused equipment seeds the first active life without counting paused item use', () => {
  const f=fixture({paused:true});
  f.equip('golden_apple');
  f.finishUse();
  f.equip('iron_sword');
  assert.equal(f.tracker.itemUsage.events.length, 0);
  f.hud('playing');
  f.packet('update_time', {});
  f.equip('golden_apple');
  f.finishUse();
  const player=f.finish().players.Alice;
  assert.equal(player.goldenApplesEaten, 1);
  assert.equal(player.ironSwordLives, 1);
});

test('spawn currentItem is held-item evidence and a new spawn clears stale hands', () => {
  const f=fixture();
  f.spawn(1,'Alice',f.tracker.world.registry.itemsByName.iron_sword.id);
  f.equip('golden_apple');
  f.spawn();
  f.finishUse();
  const player=f.finish().players.Alice;
  assert.equal(player.ironSwordLives, 1);
  assert.equal(player.goldenApplesEaten, 0);
});

test('unfinished counts stay null independently of available resource tracking', () => {
  const f=fixture();
  f.equip('iron_sword');
  const result=f.tracker.result();
  assert.equal(result.tracking.status, 'tracked');
  assert.equal(result.tracking.itemUsage.status, 'incomplete');
  for(const field of ITEM_USAGE_FIELDS) assert.equal(result.players.Alice[field], null);
});

test('mid-replay starts and navigation invalidate item counts', () => {
  for(const navigation of [true,false]) {
    const f=fixture({paused:!navigation});
    f.equip('iron_sword');
    f.hud('playing', navigation ? 0 : 20);
    if(navigation) {f.advance(); f.hud('playing',0);}
    const result=f.finish();
    assert.equal(result.tracking.itemUsage.status,'invalid');
    for(const field of ITEM_USAGE_FIELDS) assert.equal(result.players.Alice?.[field]??null,null);
  }
});

test('unsupported modern captures never claim observed item zeros', () => {
  const f=fixture({version:'1.21.11'});
  const result=f.finish();
  assert.equal(result.tracking.itemUsage.status, 'unsupported');
  for(const field of ITEM_USAGE_FIELDS) assert.equal(result.players.Alice[field],null);
});

test('playback decode errors make item counts unavailable', () => {
  const f=fixture();
  f.equip('iron_sword');
  f.packet('capture_unparsed', {raw:Buffer.from([4])});
  const result=f.finish();
  assert.equal(result.tracking.itemUsage.status, 'unavailable');
  for(const field of ITEM_USAGE_FIELDS) assert.equal(result.players.Alice[field],null);
  assert.deepEqual(result.tracking.itemUsageEvents, []);
});

test('unknown item-use evidence cannot silently produce a tracked zero', () => {
  const f=fixture();
  f.packet('named_entity_spawn',{entityId:1,playerUUID:'Alice',x:0,y:2048,z:0});
  f.finishUse();
  const result=f.finish();
  assert.equal(result.tracking.itemUsage.status, 'unavailable');
  assert.equal(result.players.Alice.goldenApplesEaten, null);
});

test('item-use evidence without a matching player cannot silently disappear', () => {
  const f=fixture();
  f.finishUse(999);
  const result=f.finish();
  assert.equal(result.tracking.itemUsage.status, 'unavailable');
  assert.equal(result.players.Alice.goldenApplesEaten, null);
});

test('late player identity resolves earlier held-item and consumption observations', () => {
  const f=fixture();
  f.packet('named_entity_spawn',{entityId:2,playerUUID:'bob-uuid',x:0,y:2048,z:0,currentItem:0});
  f.equip('iron_sword',2);
  f.equip('golden_apple',2);
  f.finishUse(2);
  f.packet('player_info',{data:[{uuid:'bob-uuid',name:'Bob'}]});
  const result=f.finish();
  assert.equal(result.tracking.itemUsage.status, 'tracked');
  assert.equal(result.players.Bob.goldenApplesEaten, 1);
  assert.equal(result.players.Bob.ironSwordLives, 1);
});

test('item observations with unresolved identities remain unavailable', () => {
  const f=fixture();
  f.packet('named_entity_spawn',{entityId:2,playerUUID:'unknown',x:0,y:2048,z:0,currentItem:0});
  f.equip('milk_bucket',2);
  f.packet('entity_destroy',{entityIds:[2]});
  const result=f.finish();
  assert.equal(result.tracking.itemUsage.status, 'unavailable');
  assert.equal(result.players.Alice.milkBucketLives, null);
});

test('known empty or unrelated held items produce tracked zero counts', () => {
  const f=fixture();
  f.equip(null);
  f.equip('wooden_sword');
  const result=f.finish();
  assert.equal(result.tracking.itemUsage.status,'tracked');
  for(const field of ITEM_USAGE_FIELDS) assert.equal(result.players.Alice[field],0);
});
