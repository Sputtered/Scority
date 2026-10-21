import test from 'node:test';
import assert from 'node:assert/strict';
import {ProtectionExperiment,armorPoints,predictedLosses,fitProtection} from '../lib/protection-estimator.js';

const armor=['leather_helmet','leather_chestplate','iron_leggings','iron_boots'];
test('legacy melee math separates critical base damage, sharpness, armor and randomized Protection',()=>{
  assert.equal(armorPoints(armor),11);assert.equal(armorPoints([undefined,...armor.slice(1)]),null);
  assert.deepEqual(predictedLosses({sword:'stone_sword',armor,protection:0}),[3.36]);
  assert.deepEqual(predictedLosses({sword:'stone_sword',armor,protection:0,sharpness:1,critical:true}),[5.74]);
  assert.deepEqual(predictedLosses({sword:'stone_sword',armor,protection:1,sharpness:1}),[3.7352,3.5728,3.4104]);
  assert.deepEqual(predictedLosses({sword:'stone_sword',armor,protection:2,sharpness:1}),[3.4104,3.248,3.0856,2.9232,2.7608]);
  assert.deepEqual(predictedLosses({sword:'stone_sword',armor,protection:1,sharpness:1,model:'linear-4pct'}),[3.4104]);
});

test('ten synthetic hits distinguish Protection II but overlapping damage remains ambiguous',()=>{
  const make=values=>values.map((healthLoss,sequence)=>({sequence,healthLoss,sword:'stone_sword',armor,sharpnessOptions:[1],criticalOptions:[false]}));
  const result=fitProtection(make([3.248,3.0856,2.9232,2.7608,3.4104,3.248,3.0856,2.9232,2.7608,3.4104]));
  assert.equal(result.status,'conditional-estimate');assert.equal(result.estimatedLevel,2);
  const overlap=fitProtection(make(Array(10).fill(3.4104)));
  assert.equal(overlap.estimatedLevel,null);assert.equal(overlap.status,'ambiguous');
  assert.deepEqual([...overlap.compatibleLevels].sort(),[1,2]);
  const short=fitProtection(make([3.248,2.7608]));assert.equal(short.estimatedLevel,null);assert.equal(short.status,'insufficient-hits');
});

test('model mismatches are retained and narrow floating-point tolerance avoids a false Prot 0 match',()=>{
  const h={sequence:1,healthLoss:5.0512,sword:'stone_sword',armor,criticalOptions:[true]};
  assert.deepEqual(fitProtection([h]).compatibleLevels,[1]);
  const result=fitProtection(Array.from({length:10},(_,sequence)=>({...h,sequence,healthLoss:1.68})));
  assert.equal(result.status,'model-mismatch');assert.equal(result.estimatedLevel,null);
});

function fixture(version='1.8.9'){
  const experiment=new ProtectionExperiment(version),legacy=version==='1.8.9';let sequence=0;
  experiment.observe({type:'capture',version,replayId:'synthetic'});
  const packet=(name,data,t=0,ms=t*1000,state=t?'playing':'paused')=>experiment.observe({type:'packet',name,data,
    sequence:sequence++,receivedMs:ms,replay:{state,elapsedSec:Math.floor(t),totalSec:120,speed:1,epoch:1}});
  const spawn=(id,name,z,color)=>{
    packet('player_info',{data:[{UUID:name,name}]});
    packet('scoreboard_team',{team:name,mode:0,prefix:color,players:[name]});
    packet(legacy?'named_entity_spawn':'spawn_entity',{entityId:id,playerUUID:name,type:experiment.world.registry.entitiesByName.player?.id,
      x:0,y:65*(legacy?32:1),z:z*(legacy?32:1),yaw:128,pitch:0});
    packet('entity_metadata',{entityId:id,metadata:[{key:0,type:0,value:0},{key:legacy?6:9,type:3,value:20},
      {key:17,type:3,value:0},...(!legacy?[{key:8,type:'byte',value:0}]:[])]});
    for(const [slot,name]of [[4,'leather_helmet'],[3,'leather_chestplate'],[2,'iron_leggings'],[1,'iron_boots'],[0,'stone_sword']]){
      const itemId=experiment.world.registry.itemsByName[name].id;
      packet('entity_equipment',legacy?{entityId:id,slot,item:{blockId:itemId,itemCount:1}}:
        {entityId:id,equipments:[{slot:slot?slot+1:0,item:{itemId,itemCount:1,components:[]}}]});
    }
  };
  spawn(1,'Victim',0,'\u00a7c');spawn(2,'Attacker',2,'\u00a7a');
  const hit=(changes=[],t=2)=>{
    packet('animation',{entityId:2,animation:0},t,t*1000);
    packet(legacy?'entity_status':'hurt_animation',{entityId:1,entityStatus:2},t,t*1000+1);
    packet('entity_metadata',{entityId:1,metadata:[...changes,{key:legacy?6:9,type:3,value:16.64}]},t,t*1000+2);
  };
  return {experiment,packet,spawn,hit};
}

test('an isolated sword hit uses the victim armor and preserves unknown Sharpness',()=>{
  for(const version of ['1.8.9','1.21.11']){
    const {experiment,hit}=fixture(version);hit();const r=experiment.select();
    assert.equal(r.selected.length,1);assert.equal(r.selected[0].attacker,'Attacker');
    assert.equal(r.selected[0].armorPoints,11);assert.equal(r.selected[0].sword,'stone_sword');
    assert.deepEqual(r.selected[0].sharpnessOptions,[0,1]);
  }
});

test('blocking at the hurt packet cannot be hidden by an unblock accompanying the health update',()=>{
  const {experiment,packet,hit}=fixture();
  packet('entity_metadata',{entityId:1,metadata:[{key:0,type:0,value:16}]},1.9,1900);
  hit([{key:0,type:0,value:0}]);
  const r=experiment.select();assert.equal(r.selected.length,0);
  assert.ok(r.rejected[0].reasons.includes('using-item-or-blocking'));
});

test('unknown attackers, absorption and incomplete armor cannot produce clean hits',()=>{
  for(const kind of ['crowd','absorption','armor']){
    const {experiment,packet,spawn,hit}=fixture();
    if(kind==='crowd')spawn(3,'OtherAttacker',2.5,'\u00a7a');
    if(kind==='absorption')packet('entity_metadata',{entityId:1,metadata:[{key:17,type:3,value:4}]},1);
    if(kind==='armor')experiment.world.entities.get(1).experimentGear.helmet=undefined;
    hit();assert.equal(experiment.select().selected.length,0,kind);
  }
});

test('a later critical animation is not borrowed from a different hit',()=>{
  const {experiment,packet,hit}=fixture();hit();
  packet('animation',{entityId:1,animation:4},2,2250);
  assert.deepEqual(experiment.select().selected[0].criticalOptions,[false,true]);
});

test('death and respawn reset health and equipment baselines',()=>{
  const {experiment,packet,hit}=fixture();hit();
  packet('chat',{position:0,message:JSON.stringify({text:'Victim was killed by Attacker.'})},3);
  packet('entity_metadata',{entityId:1,metadata:[{key:6,type:3,value:20}]},4);
  assert.equal(experiment.health.length,1);
  packet('named_entity_spawn',{entityId:1,playerUUID:'Victim',x:0,y:65*32,z:0},5);
  assert.equal(experiment.actor(1).weapon,null);assert.equal(experiment.actor(1).absorption,null);
  packet('entity_metadata',{entityId:1,metadata:[{key:6,type:3,value:3}]},5);
  assert.equal(experiment.health.length,1);
});

test('ten-hit windows require one armor segment and never turn model fit into measured accuracy',()=>{
  for(const changeArmor of [false,true]){
    const {experiment,packet,hit}=fixture();
    for(let i=0;i<10;i++){
      const t=i*3+2;
      if(i===5&&changeArmor)packet('entity_equipment',{entityId:1,slot:4,item:{blockId:310,itemCount:1}},t-1);
      packet('entity_metadata',{entityId:1,metadata:[{key:6,type:3,value:20}]},t-1);
      hit([],t);
    }
    const report=experiment.report();assert.equal(report.accuracy,null);assert.equal(report.groundTruthLabels,0);
    assert.equal(report.windows.length,changeArmor?0:1);
    if(!changeArmor)assert.equal(report.windows[0].fits[0].estimatedLevel,0);
  }
});
