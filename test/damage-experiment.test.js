import test from 'node:test';
import assert from 'node:assert/strict';
import {DamageExperiment,aimedAt,summarizeDamage,damageText} from '../lib/damage-experiment.js';
import {damageMessage} from '../lib/discord/damage-report.js';

function fixture({range=2,yaw=128,pitch=0,speed=1}={}) {
  const experiment=new DamageExperiment('1.8.9');let sequence=0;
  experiment.observe({type:'capture',version:'1.8.9',replayId:'trial'});
  const packet=(name,data,t=0,ms=t*1000/speed)=>experiment.observe({type:'packet',name,data,sequence:sequence++,receivedMs:ms,
    replay:{state:t?'playing':'paused',elapsedSec:t,totalSec:600,speed,epoch:0}});
  const spawn=(id,name,z,team)=>{
    packet('player_info',{data:[{UUID:name,name}]});
    packet('scoreboard_team',{team:name,mode:0,prefix:team,players:[name]});
    packet('named_entity_spawn',{entityId:id,playerUUID:name,x:0,y:64*32,z:z*32,yaw,pitch});
    packet('entity_metadata',{entityId:id,metadata:[{key:0,value:0},{key:6,value:20}]});
  };
  spawn(1,'Victim',0,'\u00a7c');spawn(2,'Attacker',range,'\u00a7a');
  const hit=({swing=true,hurt=true,value=16,t=1}={})=>{
    if(swing)packet('animation',{entityId:2,animation:0},t);
    if(hurt)packet('entity_status',{entityId:1,entityStatus:2},t,t*1000/speed+1);
    packet('entity_metadata',{entityId:1,metadata:[{key:6,value}]},t,t*1000/speed+2);
  };
  return {experiment,packet,spawn,hit};
}
test('yaw, pitch, range and latency allowance constrain attribution at 1x and 4x',()=>{
  for(const speed of [1,4]) {
    const {experiment,hit}=fixture({range:4.2,speed});hit();
    assert.equal(experiment.attribute({range:3.6})[0].attacker,null);
    assert.equal(experiment.attribute()[0].attacker,'Attacker');
  }
  for(const config of [{yaw:0},{pitch:64},{range:5}]){
    const {experiment,hit}=fixture(config);hit();assert.equal(experiment.attribute()[0].attacker,null);
  }
});
test('isolated fallback needs hurt and aim, and reports a distinct method',()=>{
  const {experiment,hit}=fixture();hit({swing:false});
  assert.equal(experiment.attribute({isolated:false})[0].attacker,null);
  assert.equal(experiment.attribute()[0].method,'isolated-and-aim');
  const noHurt=fixture();noHurt.hit({hurt:false});assert.equal(noHurt.experiment.attribute()[0].attacker,null);
});
test('crowds, unknown teams, same team and environmental signals prevent weak attribution',()=>{
  for(const scenario of ['crowd','unknown','team','fire']) {
    const {experiment,packet,spawn,hit}=fixture();
    if(scenario==='crowd')spawn(3,'Other',2.5,'\u00a7a');
    if(scenario==='unknown')spawn(3,'Unknown',2.5,'');
    if(scenario==='team')packet('scoreboard_team',{team:'Attacker',mode:2,prefix:'\u00a7c'});
    if(scenario==='fire')packet('entity_metadata',{entityId:1,metadata:[{key:0,value:1}]});
    hit({swing:false});assert.equal(experiment.attribute()[0].attacker,null,scenario);
  }
});
test('multiple aimed swings stay unassigned and a swing is not counted twice',()=>{
  const {experiment,packet,spawn,hit}=fixture();spawn(3,'Other',2.5,'\u00a7a');
  packet('animation',{entityId:3,animation:0},1);hit();assert.equal(experiment.attribute()[0].reason,'multiple-attackers');
  const b=fixture();b.hit();
  b.packet('entity_look',{entityId:2,yaw:128,pitch:0},1);b.packet('entity_look',{entityId:2,yaw:128,pitch:0},1);
  b.hit({swing:false,value:12});
  assert.equal(b.experiment.attribute({isolated:false}).filter(e=>e.attacker).length,1);
});
test('healing, death baseline resets, respawn and reused IDs do not create phantom health loss',()=>{
  const {experiment,packet,hit,spawn}=fixture();hit();
  packet('entity_metadata',{entityId:1,metadata:[{key:6,value:20}]},2);
  packet('chat',{position:0,message:JSON.stringify({text:'Victim was killed by Attacker.'})},3);
  packet('entity_metadata',{entityId:1,metadata:[{key:6,value:5}]},4);
  packet('entity_destroy',{entityIds:[1]},5);spawn(1,'Replacement',0,'\u00a7c');
  assert.equal(experiment.attribute().length,1);
});
test('received counts only player damage and unassigned health loss stays diagnostic',()=>{
  const r=summarizeDamage([{victim:'B',attacker:'A',healthLoss:3.1},{victim:'A',attacker:'B',healthLoss:2},{victim:'B',attacker:null,healthLoss:4}],['Quiet']);
  assert.equal(r.totals.dealt,r.totals.received);assert.equal(r.totals.observedHealthLoss,r.totals.received+r.totals.unassignedHealthLoss);
  assert.deepEqual(r.players.A.opponents.B,{dealt:3.1,received:2});assert.equal(r.players.B.unassignedHealthLoss,4);
  assert.equal(r.players.B.received,3.1);assert.equal(r.players.B.observedHealthLoss,7.1);
  assert.equal(r.damageCoverage,5.1/9.1);
  for(const p of Object.values(r.players))assert.equal(p.received,Object.values(p.opponents).reduce((n,o)=>n+o.received,0));
  assert.equal(r.players.Quiet.dealt,0);assert.equal(r.players.Quiet.received,0);
});
test('isolated health loss without another player produces zero received player damage',()=>{
  const {experiment,packet,hit}=fixture();packet('entity_destroy',{entityIds:[2]});hit({swing:false});
  const r=summarizeDamage(experiment.attribute());
  assert.equal(r.players.Victim.received,0);assert.equal(r.players.Victim.observedHealthLoss,4);
  assert.equal(r.totals.unassignedHealthLoss,4);assert.equal(r.totals.dealt,0);assert.equal(r.damageCoverage,0);
});
test('public text and embeds use player-only totals and reject old health-loss reports',()=>{
  const {experiment,hit}=fixture();hit();hit({hurt:false,swing:false,value:6,t:2});
  experiment.observe({type:'end',reason:'Replay finished'});
  experiment.lastHud={state:'finished',totalSec:600,elapsedSec:600,speed:1};
  const report={...experiment.reportDamage(),gameLabel:'G00001',captureSha256:'0123456789'};
  const message=damageMessage(report);
  assert.match(message.text,/Victim: dealt 0 \| received 4/);
  assert.match(message.text,/TOTAL: dealt 4 \| received 4/);
  assert.doesNotMatch(message.text,/unknown|coverage|received 14/i);
  assert.equal(message.embeds[0].fields.find(f=>f.name==='Victim').value,'**Dealt 0 | Received 4**\nAttacker: dealt **0**, received **4**');
  assert.equal(message.embeds[0].fields.at(-1).value,'Dealt **4** | Received **4**');
  assert.equal(report.variants.isolated.totals.unassignedHealthLoss,10);
  assert.throws(()=>damageMessage({...report,experiment:'damage-v1'}),/Regenerate/);
});
test('matching windows do not borrow swings across epochs or network gaps',()=>{
  for(const scenario of ['epoch','late']) {
    const {experiment,packet,hit}=fixture();packet('animation',{entityId:2,animation:0},1);
    if(scenario==='epoch')experiment.signals[0].epoch=99;
    if(scenario==='late')experiment.signals[0].receivedMs=-5000;
    hit({swing:false});assert.equal(experiment.attribute({isolated:false})[0].attacker,null);
  }
});
test('valid Minecraft names cannot collide with JavaScript object properties',()=>{
  const r=summarizeDamage([{victim:'__proto__',attacker:'constructor',healthLoss:4}],['toString']);
  assert.equal(r.players.constructor.dealt,4);assert.equal(r.players.__proto__.received,4);
  assert.equal(r.players.constructor.opponents.__proto__.dealt,4);assert.equal(r.players.toString.received,0);
  assert.equal(JSON.parse(JSON.stringify(r)).players.__proto__.received,4);
});
test('reports reject partial captures and 20-minute boundary, and do not claim accuracy',()=>{
  const {experiment,hit}=fixture();hit();assert.throws(()=>experiment.reportDamage(),/finished replay/);
  experiment.observe({type:'end',reason:'Replay finished'});
  experiment.lastHud={state:'finished',totalSec:1200,elapsedSec:1200,speed:1};assert.throws(()=>experiment.reportDamage(),/under 20/);
  experiment.lastHud={state:'finished',totalSec:600,elapsedSec:600,speed:1};
  const report=experiment.reportDamage();assert.equal(report.accuracy,null);assert.match(damageText(report),/Accuracy unmeasured/);
  experiment.issues.add('Replay navigation detected');assert.throws(()=>experiment.reportDamage(),/navigation/);
});
test('aim handles a player above the attacker and missing rotation',()=>{
  const v={position:{x:0,y:67,z:2}};const a={position:{x:0,y:64,z:0},yaw:0,pitch:-45};
  assert.equal(aimedAt(a,v),true);assert.equal(aimedAt({...a,pitch:45},v),false);assert.equal(aimedAt({...a,pitch:null},v),false);
});

test('unrelated packet traffic and batched timestamps cannot merge two distinct hits',()=>{
  for(const speed of [1,4])for(const batch of [false,true])for(const extra of [0,3,300]){
    const {experiment,packet}=fixture({speed});
    const ms=value=>(batch?1000:value)/speed;
    packet('animation',{entityId:2,animation:0},1,ms(1000));
    packet('entity_status',{entityId:1,entityStatus:2},1,ms(1001));
    packet('entity_metadata',{entityId:1,metadata:[{key:6,value:16}]},1,ms(1002));
    packet('animation',{entityId:2,animation:0},1,ms(1200));
    packet('entity_status',{entityId:1,entityStatus:2},1,ms(1201));
    for(let i=0;i<extra;i++)packet('keep_alive',{keepAliveId:i},1,ms(1201.5));
    packet('entity_metadata',{entityId:1,metadata:[{key:6,value:12}]},1,ms(1202));
    const events=experiment.attribute({isolated:false});
    assert.equal(summarizeDamage(events).totals.dealt,8,JSON.stringify({speed,batch,extra}));
    assert.deepEqual(events.map(e=>e.candidates[0].swingSequence),experiment.signals.filter(s=>s.kind==='swing').map(s=>s.sequence));
    assert.equal(new Set(events.flatMap(e=>e.hurtSequences)).size,2);
  }
});

test('hurt geometry survives knockback before health metadata and keeps swing-position evidence',()=>{
  for(const moved of ['victim','attacker']){
    const {experiment,packet}=fixture();
    packet('animation',{entityId:2,animation:0},1,1000);
    if(moved==='attacker')packet('entity_teleport',{entityId:2,x:0,y:64*32,z:5*32},1,1001);
    packet('entity_status',{entityId:1,entityStatus:2},1,1002);
    if(moved==='victim')packet('entity_teleport',{entityId:1,x:0,y:64*32,z:-4*32},1,1003);
    packet('entity_metadata',{entityId:1,metadata:[{key:6,value:16}]},1,1004);
    const event=experiment.attribute({isolated:false})[0];
    assert.equal(event.attacker,'Attacker',moved);
    assert.equal(event.candidates[0].distance,2);
    assert.deepEqual(event.candidates[0].victimPosition,{x:0,y:64,z:0});
    assert.deepEqual(event.candidates[0].attackerPosition,{x:0,y:64,z:2});
  }
});

test('multiple hurts sharing one health loss remain ambiguous',()=>{
  const {experiment,packet}=fixture();
  packet('animation',{entityId:2,animation:0},1,1000);
  packet('entity_status',{entityId:1,entityStatus:2},1,1001);
  packet('entity_status',{entityId:1,entityStatus:2},1,1002);
  packet('entity_metadata',{entityId:1,metadata:[{key:6,value:12}]},1,1003);
  const event=experiment.attribute()[0];
  assert.equal(event.attacker,null);assert.equal(event.reason,'multiple-hurt-events');
});
