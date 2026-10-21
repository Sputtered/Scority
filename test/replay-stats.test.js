import test from 'node:test';
import assert from 'node:assert/strict';
import {ReplayStats} from '../lib/replay-stats.js';

function fixture({speed=1,hudStep=1}={}) {
  const tracker=new ReplayStats('1.21.11');let time=0,id=100;
  const hud=t=>tracker.setPlayback({state:'playing',elapsedSec:t,totalSec:120,speed});
  hud(0);
  const packet=(name,data,t=time)=>{
    while(time<t){time=Math.min(t,time+hudStep);hud(time);}
    tracker.observe(name,data);
  };
  const spawn=(entityId,name,x,yaw)=>{
    packet('player_info',{data:[{uuid:name,player:{name}}]});
    packet('spawn_entity',{entityId,objectUUID:name,type:tracker.world.registry.entitiesByName.player.id,x,y:65.5,z:.5,yaw,pitch:0});
  };
  spawn(1,'Alice',.5,-64);spawn(2,'Bob',2.5,64);
  packet('block_change',{location:{x:10,y:65,z:0},type:tracker.world.registry.blocksByName.ender_chest.defaultState});
  const stack=(quantity,t,resource='diamond',position={x:30.5,y:67.5,z:.5})=>{
    const entityId=id++;
    packet('spawn_entity',{entityId,objectUUID:'item-'+entityId,type:tracker.world.registry.entitiesByName.item.id,...position},t);
    packet('entity_metadata',{entityId,metadata:[{key:8,type:'item_stack',value:{itemId:tracker.world.registry.itemsByName[resource].id,itemCount:quantity}}]});
    return entityId;
  };
  const collect=(item,player,t,count=1)=>packet('collect',{collectedEntityId:item,collectorEntityId:player,pickupItemCount:count},t);
  const move=(entityId,x,t)=>packet('sync_entity_position',{entityId,x,y:65.5,z:.5},t);
  const health=(entityId,value,t)=>packet('entity_metadata',{entityId,metadata:[{key:9,type:'float',value}]},t);
  const death=(text,t)=>packet('system_chat',{content:JSON.stringify({text}),isActionBar:false},t);
  const flush=t=>packet('update_time',{},t);
  return {tracker,packet,spawn,stack,collect,move,health,death,flush};
}

test('ground stack quantity credits once at inclusive five blocks, including a pickup while already in range',()=>{
  const {tracker,stack,collect,move,flush}=fixture();
  const first=stack(4,0);collect(first,1,1,1);collect(first,1,1,1);flush(3);
  assert.equal(tracker.result().players.Alice.resourceCarried.diamond,4);
  assert.equal(tracker.result().players.Alice.diamondsCollected,0);
  move(1,5.5,4);move(1,6.5,4);flush(6);
  assert.equal(tracker.result().players.Alice.diamondsCollected,4);
  assert.equal(tracker.result().players.Alice.resourceCarried.diamond,0);
  const second=stack(2,7);collect(second,1,7);flush(9);
  assert.equal(tracker.result().players.Alice.diamondsCollected,6);
  assert.equal(tracker.result().players.Alice.resourcePickups.diamond,6);
});

test('partial-stack throws remove only the ground amount and a different collector receives it',()=>{
  const {tracker,stack,collect,flush}=fixture();
  collect(stack(5,0),1,0);
  const dropped=stack(2,1,'diamond',{x:.8,y:66.8,z:.5});
  collect(dropped,2,2);flush(4);
  const p=tracker.result().players;
  assert.equal(p.Alice.resourceCarried.diamond,3);
  assert.equal(p.Bob.resourceCarried.diamond,2);
  assert.equal(tracker.result().tracking.resourceEvents.find(e=>e.kind==='throw').quantity,2);
});

test('later merged-stack metadata does not subtract the merged quantity from the original thrower',()=>{
  const {tracker,packet,stack,collect,flush}=fixture();
  collect(stack(5,0),1,0);
  const item=stack(2,1,'diamond',{x:.8,y:66.8,z:.5});
  packet('entity_metadata',{entityId:item,metadata:[{key:8,type:'item_stack',value:{itemId:tracker.world.registry.itemsByName.diamond.id,itemCount:6}}]},2);
  flush(4);
  assert.equal(tracker.result().players.Alice.resourceCarried.diamond,3);
});

test('a generator pickup near a death is not discarded as a death drop',()=>{
  const {tracker,stack,collect,death,flush}=fixture();
  const item=stack(2,0,'diamond',{x:.5,y:67.5,z:.5});
  death('Alice was killed by Bob.',0);collect(item,2,0);flush(2);
  assert.equal(tracker.result().players.Bob.resourceCarried.diamond,2);
  assert.equal(tracker.result().tracking.resourceEvents.filter(e=>e.kind==='death_drop_suppressed').length,0);
});

test('kill transfer excludes a nearby death-drop pickup and duplicate death chat',()=>{
  const {tracker,stack,collect,death,move,flush}=fixture();
  collect(stack(4,0),1,0);collect(stack(1,0),2,0);
  const item=stack(4,1,'diamond',{x:.8,y:66.8,z:.5});
  death('Alice was killed by Bob.',1);collect(item,2,1);death('Alice was killed by Bob.',1);flush(3);
  assert.equal(tracker.result().players.Alice.resourceCarried.diamond,0);
  assert.equal(tracker.result().players.Bob.resourceCarried.diamond,5);
  move(2,5.5,4);flush(6);
  assert.equal(tracker.result().players.Bob.diamondsCollected,5);
  assert.equal(tracker.result().tracking.resourceEvents.filter(e=>e.kind==='kill_transfer').length,1);
  assert.equal(tracker.result().tracking.resourceEvents.filter(e=>e.kind==='death_drop_suppressed').length,1);
});

test('previously credited resources never transfer; unidentified killers clear carried only',()=>{
  const {tracker,stack,collect,move,death,flush}=fixture();
  collect(stack(4,0,'emerald'),1,0);move(1,5.5,1);flush(3);
  move(1,.5,4);collect(stack(2,4,'emerald'),1,4);death('Alice fell into the void.',5);flush(7);
  const p=tracker.result().players;
  assert.equal(p.Alice.emeraldsCollected,4);assert.equal(p.Alice.resourceCarried.emerald,0);
  assert.equal(p.Bob.resourceCarried.emerald,0);
  assert.equal(tracker.result().tracking.resourceEvents.find(e=>e.kind==='unresolved_loss').quantity,2);
});

test('generator spawns and ambiguous player releases are not assigned as throws',()=>{
  const {tracker,stack,collect,flush}=fixture();
  collect(stack(5,0),1,0);
  stack(1,1,'diamond',{x:.5,y:67.5,z:.5});
  stack(2,1,'diamond',{x:1.5,y:66.8,z:.5});flush(3);
  assert.equal(tracker.result().players.Alice.resourceCarried.diamond,5);
  assert.ok(tracker.result().tracking.issues.some(i=>/unresolved ownership/.test(i)));
});

test('4x HUD steps preserve ground quantities, partial throws and chest credit',()=>{
  const {tracker,stack,collect,move,flush}=fixture({speed:4,hudStep:4});
  collect(stack(5,0),1,0);const dropped=stack(2,4,'diamond',{x:.8,y:66.8,z:.5});
  collect(dropped,2,4);move(1,5.5,8);move(2,5.5,8);flush(16);
  const result=tracker.result();assert.equal(result.tracking.status,'tracked');
  assert.equal(result.players.Alice.diamondsCollected,3);assert.equal(result.players.Bob.diamondsCollected,2);
  assert.equal(result.players.Alice.damageDealt,null);assert.equal(result.players.Alice.damageReceived,null);
  assert.ok(!Object.keys(result.players.Alice).some(k=>/health|healing/i.test(k)));
});

test('4x death-drop suppression spans adjacent HUD samples without double counting',()=>{
  const {tracker,stack,collect,death,move,flush}=fixture({speed:4,hudStep:4});
  collect(stack(4,0),1,0);const dropped=stack(4,0,'diamond',{x:.8,y:66.8,z:.5});
  death('Alice was killed by Bob.',4);collect(dropped,2,4);move(2,5.5,8);flush(16);
  assert.equal(tracker.result().players.Bob.diamondsCollected,4);
  assert.equal(tracker.result().tracking.resourceEvents.filter(e=>e.kind==='death_drop_suppressed').length,1);
});

test('initial merged metadata subtracts only each original release from carried resources',()=>{
  for(const resource of ['diamond','emerald']) {
    const {tracker,packet,stack,collect,move,flush}=fixture();
    collect(stack(5,0,resource),1,0);
    const a=stack(1,1,resource,{x:.8,y:66.8,z:.5});
    const b=stack(1,1,resource,{x:.85,y:66.8,z:.5});
    stack(3,1,resource,{x:.9,y:66.8,z:.5});
    packet('entity_destroy',{entityIds:[a,b]});
    move(1,5.5,4);flush(6);
    const r=tracker.result(),field=resource==='diamond'?'diamondsCollected':'emeraldsCollected';
    assert.equal(r.players.Alice[field],2,resource);
    assert.deepEqual(r.tracking.resourceEvents.filter(e=>e.kind==='throw').map(e=>e.physicalQuantity),[1,1,1]);
  }
});

test('ambiguous initial merge amounts make affected credited totals unavailable',()=>{
  const {tracker,packet,stack,collect,move,flush}=fixture();
  collect(stack(5,0),1,0);
  const a=stack(2,1,'diamond',{x:.8,y:66.8,z:.5});
  const b=stack(2,1,'diamond',{x:2.7,y:66.8,z:.5});
  packet('sync_entity_position',{entityId:b,x:.85,y:66.8,z:.5});
  stack(3,1,'diamond',{x:.9,y:66.8,z:.5});packet('entity_destroy',{entityIds:[a,b]});
  move(1,5.5,4);flush(6);
  const r=tracker.result();assert.equal(r.players.Alice.diamondsCollected,null);
  assert.equal(r.players.Alice.emeraldsCollected,0);
  assert.deepEqual(r.tracking.unresolvedResourceAmounts,['diamond']);
  assert.equal(r.tracking.resourceEvents.filter(e=>e.kind==='throw_unresolved').length,1);
});

test('4x batched movement recognizes a release along the last movement without sweeping teleports',()=>{
  for(const teleport of [false,true]) {
    const tracker=new ReplayStats('1.8.9');
    const hud=t=>tracker.setPlayback({state:'playing',elapsedSec:t,totalSec:120,speed:4});
    const packet=(name,data)=>tracker.observe(name,data);
    const stack=(entityId,count,x,y)=>{
      packet('spawn_entity',{entityId,type:2,x:x*32,y:y*32,z:16});
      packet('entity_metadata',{entityId,metadata:[{key:10,type:5,value:{blockId:264,itemCount:count}}]});
    };
    hud(0);
    packet('player_info',{data:[{UUID:'alice',name:'Alice'}]});
    packet('named_entity_spawn',{entityId:1,playerUUID:'alice',x:16,y:65.5*32,z:16});
    stack(100,5,30.5,67.5);
    packet('collect',{collectedEntityId:100,collectorEntityId:1});hud(4);
    if(teleport)packet('entity_teleport',{entityId:1,x:16,y:62.5*32,z:16});
    else packet('rel_entity_move',{entityId:1,dX:0,dY:-3*32,dZ:0});
    stack(101,2,.625,65.3125);hud(8);hud(12);packet('update_time',{});
    assert.equal(tracker.result().players.Alice.resourceCarried.diamond,teleport?5:3);
  }
});

test('4x rewinds and large forward seeks invalidate resource totals; normal steps do not',()=>{
  for(const elapsedSec of [0,32]) {
    const {tracker,flush}=fixture({speed:4,hudStep:4});flush(8);
    assert.equal(tracker.result().tracking.status,'tracked');
    tracker.setPlayback({state:'playing',elapsedSec,totalSec:120,speed:4});
    assert.equal(tracker.result().tracking.status,'invalid');assert.equal(tracker.result().players.Alice.diamondsCollected,null);
  }
});

test('pausing does not add resource pickups and resuming preserves the current balance',()=>{
  const {tracker,stack,collect}=fixture({speed:4,hudStep:4});
  const first=stack(3,0);collect(first,1,0);
  tracker.setPlayback({state:'paused',elapsedSec:0,totalSec:120,speed:4});
  const second=stack(5,0);collect(second,1,0);
  tracker.setPlayback({state:'playing',elapsedSec:0,totalSec:120,speed:4});
  tracker.setPlayback({state:'finished',elapsedSec:0,totalSec:120,speed:4});
  assert.equal(tracker.result().players.Alice.resourceCarried.diamond,3);
});
