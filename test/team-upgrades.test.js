import test from 'node:test';
import assert from 'node:assert/strict';
import {inferTeamUpgrades,upgradeLine} from '../lib/team-upgrades.js';
import {ReplayStats} from '../lib/replay-stats.js';

const armor=['leather_helmet','leather_chestplate','iron_leggings','iron_boots'];
const hit=(sequence,t,healthLoss,extra={})=>({sequence,t,healthLoss,armor,sword:'stone_sword',team:'c',attackerTeam:'a',
  epoch:1,resolution:1,criticalOptions:[false,true],sharpnessOptions:[0,1],...extra});

test('team upgrades require separate corroboration and preserve acquisition bounds, not purchase timestamps',()=>{
  const r=inferTeamUpgrades([hit(1,10,3.36),hit(2,30,3.7352),hit(3,34,3.7352)]);
  assert.equal(r.teams.red.protection1.status,'estimated');
  assert.equal(r.teams.red.protection1.afterSec,10);assert.equal(r.teams.red.protection1.bySec,31);
  assert.deepEqual(r.teams.red.protection1.evidence,[2,3]);
  assert.equal(r.teams.green.sharpness.bySec,31);
  assert.equal(r.teams.red.sharpness.status,'unobserved');
  assert.equal(r.teams.red.protection2.status,'unobserved');assert.equal(r.accuracy,null);
  assert.equal(inferTeamUpgrades([hit(1,10,3.7352)]).teams.red.protection1.status,'unobserved');
  assert.equal(inferTeamUpgrades([hit(1,10,3.7352),hit(1,10,3.7352)]).teams.red.protection1.status,'unobserved');
});

test('overlapping levels establish only lower upgrades; P3 and P4 can be detected without inventing skipped times',()=>{
  const ambiguous=inferTeamUpgrades([hit(1,10,3.4104),hit(2,12,3.4104)]);
  assert.equal(ambiguous.teams.red.protection1.status,'estimated');
  assert.equal(ambiguous.teams.red.protection2.status,'unobserved');
  for(const [damage,level]of [[2.1504,3],[1.344,4]]){
    const r=inferTeamUpgrades([hit(1,20,damage),hit(2,22,damage)]);
    for(let n=1;n<=level;n++)assert.equal(r.teams.red[`protection${n}`].bySec,21);
    if(level===3)assert.equal(r.teams.red.protection4.status,'unobserved');
    assert.equal(r.teams.red.protection1.afterSec,null);
  }
});

test('contradictions, separated hits, replay seeks and incomplete recordings withhold estimates',()=>{
  const initial=[hit(1,10,3.7352),hit(2,12,3.7352)];
  assert.equal(inferTeamUpgrades([...initial,hit(3,20,3.36)]).teams.red.protection1.status,'conflicting');
  assert.equal(inferTeamUpgrades([initial[0],hit(2,150,3.7352)]).teams.red.protection1.status,'unobserved');
  assert.equal(inferTeamUpgrades([initial[0],hit(2,12,3.7352,{epoch:2})]).teams.red.protection1.status,'invalid');
  assert.equal(inferTeamUpgrades(initial,{status:'incomplete'}).teams.red.protection1.bySec,null);
  const stats=new ReplayStats('1.8.9');stats.setPlayback({state:'playing',elapsedSec:0,totalSec:180,speed:4});
  assert.equal(stats.result().teamUpgrades.status,'incomplete');
  stats.setPlayback({state:'playing',elapsedSec:50,totalSec:180,speed:4});
  stats.setPlayback({state:'finished',elapsedSec:180,totalSec:180,speed:4});
  assert.equal(stats.result().teamUpgrades.status,'invalid');
});

test('4x timing includes HUD uncertainty; mismatches stay counted and missing data stays unavailable',()=>{
  const r=inferTeamUpgrades([hit(1,20,3.7352,{resolution:4}),hit(2,24,3.7352,{resolution:4}),hit(3,30,1.68)],{totalSec:180});
  assert.equal(r.teams.red.protection1.bySec,24);assert.equal(r.unexplainedHits,1);
  assert.match(upgradeLine(r,'red'),/P1 0:24/);assert.match(upgradeLine(undefined,'red'),/P4 —/);
});
