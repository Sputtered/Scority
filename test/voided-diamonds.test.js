import test from 'node:test';
import assert from 'node:assert/strict';
import {ReplayStats} from '../lib/replay-stats.js';

function fixture({speed=1}={}) {
  const tracker=new ReplayStats('1.21.11');let time=0,id=100;
  const hud=t=>tracker.setPlayback({state:'playing',elapsedSec:t,totalSec:120,speed});
  hud(0);
  const packet=(name,data,t=time)=>{
    while(time<t){time=Math.min(t,time+speed);hud(time);}
    tracker.observe(name,data);
  };
  const player=(entityId,name,x)=>{
    packet('player_info',{data:[{uuid:name,player:{name}}]});
    packet('spawn_entity',{entityId,objectUUID:name,type:tracker.world.registry.entitiesByName.player.id,x,y:65.5,z:.5});
  };
  player(1,'Alice',.5);player(2,'Bob',10.5);
  const metadata=(entityId,count)=>packet('entity_metadata',{entityId,metadata:[{key:8,type:'item_stack',
    value:{itemId:tracker.world.registry.itemsByName.diamond.id,itemCount:count}}]});
  const stack=(count,{x=.8,y=66.8,z=.5,t=time,entityId=id++}={})=>{
    packet('spawn_entity',{entityId,objectUUID:'item-'+entityId,type:tracker.world.registry.entitiesByName.item.id,x,y,z},t);
    metadata(entityId,count);return entityId;
  };
  const move=(entityId,{x=.8,y=-5,z=.5,t=time}={})=>packet('sync_entity_position',{entityId,x,y,z},t);
  const remove=entityId=>packet('entity_destroy',{entityIds:[entityId]});
  const collect=(entityId,collectorEntityId=2)=>packet('collect',{collectedEntityId:entityId,collectorEntityId,pickupItemCount:1});
  const finish=()=>{tracker.setPlayback({state:'finished',elapsedSec:time,totalSec:120,speed});return tracker.result();};
  return {tracker,packet,player,stack,metadata,move,remove,collect,finish};
}

test('physical diamond throws into the void use stack amount even without a carried balance',()=>{
  for(const speed of [1,4]) {
    const f=fixture({speed}),item=f.stack(3);
    f.move(item,{t:speed});f.remove(item);
    const r=f.finish();
    assert.equal(r.players.Alice.diamondsVoided,3);
    assert.equal(r.players.Bob.diamondsVoided,0);
    assert.equal(r.tracking.resourceEvents.find(e=>e.kind==='throw').quantity,0);
    const event=r.tracking.resourceEvents.find(e=>e.kind==='void');
    assert.equal(event.quantity,3);assert.equal(event.attribution,'inferred');
    assert.equal(r.tracking.voidedDiamonds.status,'tracked');
    assert.deepEqual(f.tracker.result(),r,'repeated results must not double count');
  }
});

test('same-position repeated throws remain throws and subtract each physical release',()=>{
  const f=fixture();
  f.packet('block_change',{location:{x:10,y:65,z:0},type:f.tracker.world.registry.blocksByName.ender_chest.defaultState});
  const pickup=f.stack(5,{x:30.5,y:67.5});f.collect(pickup,1);f.remove(pickup);
  const a=f.stack(2,{t:1}),b=f.stack(2,{t:2});
  f.move(a);f.remove(a);f.move(b);f.remove(b);
  f.move(1,{x:5.5,y:65.5,t:3});
  const r=f.finish();
  assert.equal(r.players.Alice.diamondsCollected,1);
  assert.equal(r.players.Alice.diamondsVoided,4);
  assert.equal(r.tracking.resourceEvents.filter(e=>e.kind==='throw').length,2);
});

test('collected throws, generator items, death drops and disappearance above the floor do not count',()=>{
  for(const scenario of ['pickup','generator','death','despawn','initiallyBelow','stillVisible']) {
    const f=fixture();
    const item=f.stack(2,scenario==='generator'?{x:30.5,y:67.5}:scenario==='initiallyBelow'?{y:-2}:{});
    if(scenario==='death')f.packet('system_chat',{content:JSON.stringify({text:'Alice was killed by Bob.'}),isActionBar:false});
    if(scenario==='pickup')f.collect(item);
    if(scenario!=='despawn')f.move(item);
    if(scenario!=='stillVisible')f.remove(item);
    assert.equal(f.finish().players.Alice.diamondsVoided,0,scenario);
  }
});

test('a player falling while carrying diamonds is not a physical throw',()=>{
  const f=fixture(),item=f.stack(4,{x:30.5,y:67.5});f.collect(item,1);f.remove(item);
  f.move(1);f.packet('system_chat',{content:JSON.stringify({text:'Alice fell into the void.'}),isActionBar:false});
  assert.equal(f.finish().players.Alice.diamondsVoided,0);
});

test('same-owner stacks merge into one falling stack with conserved quantity and provenance',()=>{
  const f=fixture(),donor=f.stack(2),survivor=f.stack(1,{x:1});
  f.metadata(survivor,3);f.remove(donor);f.move(survivor);f.remove(survivor);
  const r=f.finish(),events=r.tracking.resourceEvents.filter(e=>e.kind==='void');
  assert.equal(r.players.Alice.diamondsVoided,3);assert.equal(events.length,1);
  assert.equal(events[0].sourceGenerations.length,2);
});

test('initial metadata that already contains merged stacks is counted once',()=>{
  const f=fixture(),a=f.stack(1),b=f.stack(1,{x:.9}),survivor=f.stack(3,{x:1});
  f.remove(a);f.remove(b);f.move(survivor);f.remove(survivor);
  const r=f.finish();assert.equal(r.players.Alice.diamondsVoided,3);
  assert.equal(r.tracking.resourceEvents.find(e=>e.kind==='void').sourceGenerations.length,3);
});

test('mixed-owner and unobserved merges remain unresolved instead of assigning their quantities',()=>{
  for(const mixed of [true,false]) {
    const f=fixture(),survivor=f.stack(1);
    if(mixed) {
      const donor=f.stack(1,{x:10.8});
      f.move(donor,{x:1,y:66.8});f.metadata(survivor,2);f.remove(donor);
    } else f.metadata(survivor,2);
    f.move(survivor);f.remove(survivor);
    const r=f.finish();assert.equal(r.players.Alice.diamondsVoided,0);
    assert.equal(r.players.Bob.diamondsVoided,0);assert.equal(r.tracking.voidedDiamonds.unresolvedEvents,1);
    assert.equal(r.tracking.resourceEvents.find(e=>e.kind==='void_unresolved').reason,'unresolved_stack_merge');
  }
});

test('ambiguous owners never produce a void credit',()=>{
  const f=fixture();f.move(2,{x:1.5,y:65.5});
  const item=f.stack(2,{x:1});f.move(item);f.remove(item);
  const r=f.finish();assert.equal(r.players.Alice.diamondsVoided,0);assert.equal(r.players.Bob.diamondsVoided,0);
  assert.equal(r.tracking.voidedDiamonds.unresolvedEvents,1);
});

test('a vanished donor that could explain two stacks is never assigned twice',()=>{
  const f=fixture(),donor=f.stack(2),a=f.stack(1,{x:.9}),b=f.stack(1,{x:1});
  f.metadata(a,3);f.metadata(b,3);f.remove(donor);
  f.move(a);f.remove(a);f.move(b);f.remove(b);
  const r=f.finish();assert.equal(r.players.Alice.diamondsVoided,0);
  assert.equal(r.tracking.voidedDiamonds.unresolvedEvents,2);
});

test('competing mixed-owner donors cannot silently become the first observed stack owner',()=>{
  const f=fixture(),alice=f.stack(2),bob=f.stack(2,{x:10.8});
  f.move(bob,{x:1,y:66.8});
  const survivor=f.stack(3,{x:1.1});
  f.remove(alice);f.remove(bob);f.move(survivor);f.remove(survivor);
  const r=f.finish();assert.equal(r.players.Alice.diamondsVoided,0);assert.equal(r.players.Bob.diamondsVoided,0);
  assert.equal(r.tracking.voidedDiamonds.unresolvedEvents,1);
});

test('a chain of merges preserves the original source generations without counting donors',()=>{
  const f=fixture(),first=f.stack(1),middle=f.stack(2,{x:.9});f.remove(first);
  const last=f.stack(1,{x:1});f.metadata(last,3);f.remove(middle);f.move(last);f.remove(last);
  const r=f.finish();assert.equal(r.players.Alice.diamondsVoided,3);
  assert.equal(r.tracking.resourceEvents.find(e=>e.kind==='void').sourceGenerations.length,3);
});

test('initial metadata merge chains do not count an absorbed donor again',()=>{
  for(const speed of [1,4]) {
    const f=fixture({speed});
    f.packet('block_change',{location:{x:10,y:65,z:0},type:f.tracker.world.registry.blocksByName.ender_chest.defaultState});
    const pickup=f.stack(5,{x:30.5,y:67.5});f.collect(pickup,1);f.remove(pickup);
    const first=f.stack(1),middle=f.stack(2,{x:.9,t:speed});f.remove(first);
    const last=f.stack(3,{x:1,t:2*speed});f.remove(middle);f.move(last);f.remove(last);
    f.move(1,{x:5.5,y:65.5,t:3*speed});
    const r=f.finish(),events=r.tracking.resourceEvents;
    assert.equal(r.players.Alice.diamondsCollected,2);
    assert.equal(r.players.Alice.diamondsVoided,3);
    assert.deepEqual(r.tracking.unresolvedResourceAmounts,[]);
    assert.deepEqual(events.filter(e=>e.kind==='throw').map(e=>e.physicalQuantity),[1,1,1]);
    assert.equal(events.find(e=>e.kind==='void').sourceGenerations.length,3);
  }
});

test('initial metadata merge chains retain mixed ownership uncertainty',()=>{
  const f=fixture(),first=f.stack(1,{x:10.8});f.move(first,{x:.8,y:66.8});
  const middle=f.stack(2,{x:.9});f.remove(first);
  const last=f.stack(3,{x:1});f.remove(middle);f.move(last);f.remove(last);
  const r=f.finish();
  assert.equal(r.players.Alice.diamondsVoided,0);assert.equal(r.players.Bob.diamondsVoided,0);
  assert.equal(r.tracking.voidedDiamonds.unresolvedEvents,1);
  assert.deepEqual(r.tracking.resourceEvents.filter(e=>e.kind==='throw').map(e=>e.physicalQuantity),[1,1,1]);
});

test('a merge chain can remove both absorbed stacks in one destruction packet',()=>{
  for(const speed of [1,4]) {
    const f=fixture({speed});
    f.packet('block_change',{location:{x:10,y:65,z:0},type:f.tracker.world.registry.blocksByName.ender_chest.defaultState});
    const pickup=f.stack(5,{x:30.5,y:67.5});f.collect(pickup,1);f.remove(pickup);
    const first=f.stack(1),middle=f.stack(1,{x:.9});f.metadata(middle,2);
    const last=f.stack(3,{x:1});f.packet('entity_destroy',{entityIds:[first,middle]});
    f.move(last);f.remove(last);f.move(1,{x:5.5,y:65.5,t:speed});
    const r=f.finish(),events=r.tracking.resourceEvents;
    assert.equal(r.players.Alice.diamondsCollected,2);
    assert.equal(r.players.Alice.diamondsVoided,3);
    assert.deepEqual(r.tracking.unresolvedResourceAmounts,[]);
    assert.deepEqual(events.filter(e=>e.kind==='throw').map(e=>e.physicalQuantity),[1,1,1]);
    assert.equal(events.find(e=>e.kind==='void').sourceGenerations.length,3);
  }
});

test('competing recipients removed in one packet still leave the shared donor unresolved',()=>{
  const f=fixture(),donor=f.stack(1),a=f.stack(2,{x:.9}),b=f.stack(2,{x:1});
  f.packet('entity_destroy',{entityIds:[donor,a,b]});
  const r=f.finish();
  assert.equal(r.players.Alice.diamondsVoided,0);
  assert.deepEqual(r.tracking.unresolvedResourceAmounts,['diamond']);
  assert.equal(r.tracking.resourceEvents.filter(e=>e.kind==='throw_unresolved').length,2);
});

test('initial metadata still leaves independent competing recipients unresolved',()=>{
  const f=fixture(),donor=f.stack(1),a=f.stack(2,{x:.9}),b=f.stack(2,{x:1});
  f.remove(donor);f.move(a);f.remove(a);f.move(b);f.remove(b);
  const r=f.finish();
  assert.equal(r.players.Alice.diamondsVoided,0);
  assert.equal(r.tracking.voidedDiamonds.unresolvedEvents,2);
  assert.equal(r.tracking.resourceEvents.filter(e=>e.kind==='throw_unresolved').length,2);
});

test('an oversized intermediate stack cannot hide a competing donor',()=>{
  const f=fixture(),donor=f.stack(1,{x:10.8});f.move(donor,{x:.8,y:66.8});
  const intermediate=f.stack(3,{x:.9}),last=f.stack(2,{x:1});
  f.remove(donor);f.remove(intermediate);f.move(last);f.remove(last);
  const r=f.finish();
  assert.equal(r.players.Alice.diamondsVoided,0);assert.equal(r.players.Bob.diamondsVoided,0);
  assert.equal(r.tracking.voidedDiamonds.unresolvedEvents,1);
});

test('the void boundary follows the recorded world floor and never assumes Y=0',()=>{
  for(const y of [-5,-65]) {
    const f=fixture();f.tracker.world.world.minY=-64;
    const item=f.stack(1);f.move(item,{y});f.remove(item);
    assert.equal(f.finish().players.Alice.diamondsVoided,y===-65?1:0);
  }
});

test('an unexplained stack decrease prevents a confident void quantity',()=>{
  const f=fixture(),item=f.stack(4);f.metadata(item,2);f.move(item);f.remove(item);
  const r=f.finish();assert.equal(r.players.Alice.diamondsVoided,0);
  assert.equal(r.tracking.voidedDiamonds.unresolvedEvents,1);
});

test('entity IDs can be reused without attributing a later pickup to an earlier void',()=>{
  const f=fixture(),first=f.stack(2,{entityId:500});f.move(first);f.remove(first);
  const second=f.stack(1,{entityId:500,x:10.8,t:1});f.collect(second);f.remove(second);
  const r=f.finish();assert.equal(r.players.Alice.diamondsVoided,2);assert.equal(r.players.Bob.diamondsVoided,0);
});

test('a collection observed before item identity is known still excludes that entity generation',()=>{
  const f=fixture(),entityId=900;
  f.packet('spawn_entity',{entityId,objectUUID:'late-metadata',type:f.tracker.world.registry.entitiesByName.item.id,x:.8,y:66.8,z:.5});
  f.collect(entityId);f.metadata(entityId,3);f.move(entityId);f.remove(entityId);
  const r=f.finish();assert.equal(r.players.Alice.diamondsVoided,0);
  assert.equal(r.tracking.voidedDiamonds.unresolvedCollections,1);
});

test('finished valid empty evidence supports zero; incomplete, corrupt and rewound captures remain unavailable',()=>{
  assert.equal(fixture().finish().players.Alice.diamondsVoided,0);
  const incomplete=fixture();assert.equal(incomplete.tracker.result().players.Alice.diamondsVoided,null);
  const corrupt=fixture();corrupt.packet('capture_unparsed',{raw:{$buffer:'AA=='}});
  assert.equal(corrupt.finish().players.Alice.diamondsVoided,null);
  assert.equal(corrupt.tracker.result().tracking.voidedDiamonds.status,'unavailable');
  const rewind=fixture();rewind.packet('update_time',{},2);
  rewind.tracker.setPlayback({state:'playing',elapsedSec:0,totalSec:120,speed:1});
  assert.equal(rewind.finish().players.Alice.diamondsVoided,null);
  assert.equal(rewind.tracker.result().tracking.voidedDiamonds.status,'invalid');
});

test('a participant known only through death chat cannot receive an observed zero',()=>{
  const f=fixture();
  f.packet('system_chat',{content:JSON.stringify({text:'Unobserved was killed by Alice.'}),isActionBar:false});
  const r=f.finish();assert.equal(r.players.Alice.diamondsVoided,0);
  assert.equal(r.players.Unobserved.diamondsVoided,null);
});
