import test from 'node:test';
import assert from 'node:assert/strict';
import {PlayerDamage,PLAYER_DAMAGE_VERSION} from '../lib/player-damage.js';
import {ReplayStats} from '../lib/replay-stats.js';

function fixture({speed=1,parseDeaths=true}={}) {
  const tracker=new PlayerDamage('1.8.9',{parseDeaths});let sequence=0,time=0;
  const packet=(name,data,t=time)=>{time=t;tracker.observe({type:'packet',name,data,sequence:sequence++,receivedMs:t*1000/speed,
    replay:{state:'playing',elapsedSec:t,totalSec:1800,speed,epoch:0}});};
  const health=value=>packet('entity_metadata',{entityId:1,metadata:[{key:6,value}]});
  const spawn=(id,name,team,z)=>{
    packet('player_info',{data:[{UUID:name,name}]});packet('scoreboard_team',{team:name,mode:0,prefix:team,players:[name]});
    packet('named_entity_spawn',{entityId:id,playerUUID:name,x:0,y:64*32,z:z*32,yaw:128,pitch:0});
    packet('entity_metadata',{entityId:id,metadata:[{key:6,value:20}]});
  };
  spawn(1,'Victim','\u00a7c',0);spawn(2,'Attacker','\u00a7a',2);
  const hit=()=>{packet('animation',{entityId:2,animation:0},1);packet('entity_status',{entityId:1,entityStatus:2});health(16);};
  const fall=()=>packet('entity_teleport',{entityId:1,x:0,y:-10*32,z:0},2);
  const death=(message='Victim was thrown into the void by Attacker.')=>packet('chat',{position:0,message:JSON.stringify({text:message})},3);
  return {tracker,packet,health,spawn,hit,fall,death};
}
test('credited void finishes add remaining HP to both players at 1x and 4x',()=>{
  for(const speed of [1,4]){
    const f=fixture({speed});f.hit();f.fall();f.death();
    const r=f.tracker.score();assert.equal(r.players.Attacker.dealt,20);assert.equal(r.players.Victim.received,20);
    assert.deepEqual(r.players.Attacker.opponents.Victim,{dealt:20,received:0});assert.equal(r.voidFinishDamage,16);
    assert.equal(r.totals.dealt,r.totals.received);
  }
});
test('zero updates before or after death and duplicate chat cannot double-count void damage',()=>{
  for(const order of ['before','after']){
    const f=fixture();f.hit();f.fall();if(order==='before')f.health(0);f.death();
    if(order==='after')f.health(0);f.death();
    const r=f.tracker.score();assert.equal(r.totals.dealt,20,order);assert.equal(r.totals.received,20,order);
    assert.equal(r.voidFinishDamage,16);assert.equal(r.totals.unassignedHealthLoss,0);
  }
});
test('several void ticks are credited once and a new life starts with a fresh baseline',()=>{
  const f=fixture();f.hit();f.fall();f.health(12);f.health(8);f.death();
  assert.equal(f.tracker.score().totals.dealt,20);
  f.spawn(1,'Victim','\u00a7c',0);f.health(15);
  const r=f.tracker.score();assert.equal(r.totals.dealt,20);assert.equal(r.totals.unassignedHealthLoss,5);
  assert.equal(r.totals.received,20);
});
test('solo voids, unknown killers, teammates and self kills never receive void credit',()=>{
  for(const message of ['Victim fell into the void.','Victim was thrown into the void by Missing.','Victim was thrown into the void by Victim.']){
    const f=fixture();f.fall();f.death(message);assert.equal(f.tracker.score().totals.dealt,0,message);
  }
  const f=fixture();f.packet('scoreboard_team',{team:'Attacker',mode:2,prefix:'\u00a7c'});f.fall();f.death();
  assert.equal(f.tracker.score().totals.dealt,0);
});
test('generic credited death below the map counts; generic land deaths do not become void finishes',()=>{
  const a=fixture();a.hit();a.fall();a.death('Victim was killed by Attacker.');assert.equal(a.tracker.score().totals.dealt,20);
  const b=fixture();b.hit();b.death('Victim was killed by Attacker.');assert.equal(b.tracker.score().totals.dealt,4);
});
test('destroyed victim retains its own HP but a reused entity ID cannot supply HP for another player',()=>{
  const a=fixture();a.hit();a.fall();a.packet('entity_destroy',{entityIds:[1]});a.death();assert.equal(a.tracker.score().totals.dealt,20);
  const b=fixture();b.hit();b.fall();b.packet('entity_destroy',{entityIds:[1]});b.spawn(1,'Replacement','\u00a7c',0);
  b.death();assert.equal(b.tracker.score().players.Victim.received,20);assert.equal(b.tracker.score().players.Replacement.received,0);
});
test('explicit void death with terminal zero can recover its unassigned final health drop',()=>{
  const f=fixture();f.hit();f.packet('entity_teleport',{entityId:1,x:0,y:10*32,z:0},2);f.health(0);f.death();
  assert.equal(f.tracker.score().totals.dealt,20);assert.equal(f.tracker.score().totals.unassignedHealthLoss,0);
});
test('production replay stats publish player damage only on completed valid captures',()=>{
  const replay=new ReplayStats('1.8.9');let sequence=0;
  replay.setPlayback({state:'playing',elapsedSec:0,totalSec:1800,speed:1});
  const packet=(name,data)=>replay.observe(name,data,'play',sequence++,1000);
  for(const [id,name,prefix,z]of [[1,'Victim','\u00a7c',0],[2,'Attacker','\u00a7a',2]]){
    packet('player_info',{data:[{UUID:name,name}]});packet('scoreboard_team',{team:name,mode:0,prefix,players:[name]});
    packet('named_entity_spawn',{entityId:id,playerUUID:name,x:0,y:2048,z:z*32,yaw:128,pitch:0});
    packet('entity_metadata',{entityId:id,metadata:[{key:6,value:20}]});
  }
  packet('animation',{entityId:2,animation:0});packet('entity_status',{entityId:1,entityStatus:2});
  packet('entity_metadata',{entityId:1,metadata:[{key:6,value:16}]});
  assert.equal(replay.result().players.Victim.damageReceived,null);
  for(let t=2;t<=1800;t+=2)replay.setPlayback({state:t===1800?'finished':'playing',elapsedSec:t,totalSec:1800,speed:1});
  const r=replay.result();assert.equal(r.players.Attacker.damageDealt,4);assert.equal(r.players.Victim.damageReceived,4);
  assert.equal(r.tracking.damage.status,'tracked');assert.equal(r.tracking.damage.scope,'attributed-player-damage');
  assert.equal(r.tracking.damage.version,PLAYER_DAMAGE_VERSION);
  replay.invalidate('test invalidation');assert.equal(replay.result().players.Victim.damageReceived,null);
});

test('a player named Void cannot turn a land death into a credited void finish',()=>{
  for(const name of ['Void','vOiD']){
    const killer=fixture();killer.spawn(2,name,'\u00a7a',2);killer.death(`Victim was killed by ${name}.`);
    assert.equal(killer.tracker.score().voidFinishDamage,0);
    const victim=fixture();victim.spawn(1,name,'\u00a7c',0);victim.death(`${name} was killed by Attacker.`);
    assert.equal(victim.tracker.score().voidFinishDamage,0);
    const actualVoid=fixture();actualVoid.spawn(1,name,'\u00a7c',0);actualVoid.death(`${name} was thrown into the void by Attacker.`);
    assert.equal(actualVoid.tracker.score().voidFinishDamage,20);
  }
});

test('a reused entity cannot borrow hurt and swing signals from its previous life',()=>{
  const f=fixture();
  f.packet('animation',{entityId:2,animation:0},1);
  f.packet('entity_status',{entityId:1,entityStatus:2},1);
  f.packet('chat',{position:0,message:JSON.stringify({text:'Victim was killed by Attacker.'})},1);
  f.health(20);f.health(16);
  const event=f.tracker.score().events[0];
  assert.equal(event.healthLoss,4);assert.equal(event.attacker,null);assert.equal(event.reason,'no-hurt-event');
});

test('a dead attacker cannot deal melee damage through a lingering entity or late swing',()=>{
  const f=fixture();
  f.packet('chat',{position:0,message:JSON.stringify({text:'Attacker was killed by Victim.'})},1);
  f.packet('animation',{entityId:2,animation:0},1);
  f.packet('entity_status',{entityId:1,entityStatus:2},1);f.health(16);
  assert.equal(f.tracker.score().players.Attacker.dealt,0);
  f.packet('entity_metadata',{entityId:2,metadata:[{key:6,value:20}]},2);
  f.packet('animation',{entityId:2,animation:0},2);
  f.packet('entity_status',{entityId:1,entityStatus:2},2);f.health(12);
  assert.equal(f.tracker.score().players.Attacker.dealt,4);
});

test('a dead killer can retain a server-credited posthumous void finish',()=>{
  const f=fixture();f.hit();f.fall();
  f.packet('chat',{position:0,message:JSON.stringify({text:'Attacker was killed by Victim.'})},2);
  f.death();
  assert.equal(f.tracker.score().players.Attacker.dealt,20);
  assert.equal(f.tracker.score().voidFinishDamage,16);
});
