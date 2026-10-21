import test from 'node:test';
import assert from 'node:assert/strict';
import {applyAssists} from '../lib/assists.js';
import {ReplayStore,ADMIN_ID} from '../lib/discord/store.js';
import {playerStats,gameMatchups} from '../lib/discord/stats.js';
import {gameCardFingerprint} from '../lib/discord/cards/snapshot.js';
import {createCaptureMatch,scorePacket} from '../lib/capture-scoring.js';

function fixture(){return {match:{winner:'red',totalDurationSec:600},players:Object.fromEntries([['Killer','red'],['Helper','red'],['Helper2','red'],['Rival','blue'],['Victim','green']].map(([name,team])=>[name,{team,kills:0,deaths:0,finalKills:0,bedBreaks:0,longestStreak:0}])),
  killFeed:[{t:20,sequence:100,lifeId:1,killer:'Killer',victim:'Victim',finalKill:false}],bedBreaks:[],tracking:{status:'tracked',damage:{version:1,status:'tracked',scope:'attributed-player-damage'},damageEvents:[]}};}
const hit=(attacker='Helper',healthLoss=2,t=15,lifeId=1,sequence=50)=>({attacker,victim:'Victim',healthLoss,t,lifeId,sequence,method:'swing-and-aim'});

test('2 HP and 10 seconds are inclusive; helpers receive one assist each and killer/rivals receive none',()=>{
  const p=fixture();p.tracking.damageEvents=[hit('Helper',1,10,1,40),hit('Helper',1,15),hit('Helper2',9,15,1,60),hit('Killer',5,15,1,70),hit('Rival',10,15,1,80)];
  applyAssists(p);assert.equal(p.players.Helper.assists,1);assert.equal(p.players.Helper2.assists,1);
  assert.equal(p.players.Killer.assists,0);assert.equal(p.players.Rival.assists,0);
  assert.equal(p.players.Helper.assistsByOpponent.Victim,1);assert.equal(p.tracking.assistEvents.length,2);
});

test('small, expired, later, unrelated-life and environmental damage cannot award assists',()=>{
  for(const e of [hit('Helper',1.99),hit('Helper',2,9.99),hit('Helper',2,21),hit('Helper',2,15,2),hit('Helper',2,20,1,101),{...hit(),attacker:null},{...hit(),method:'credited-void-loss'}]){
    const p=fixture();p.tracking.damageEvents=[e];applyAssists(p);assert.equal(p.players.Helper.assists,0,JSON.stringify(e));
  }
  for(const killer of [null,'Missing','Victim']){const p=fixture();p.killFeed[0].killer=killer;p.tracking.damageEvents=[hit()];applyAssists(p);assert.equal(p.players.Helper.assists,0);}
});

test('repeat deaths reset contributions, including respawns and two deaths within one HUD second',()=>{
  const p=fixture();p.tracking.damageEvents=[hit()];p.killFeed.push({...p.killFeed[0],t:21,sequence:200,lifeId:2});
  applyAssists(p);assert.equal(p.players.Helper.assists,1);
  p.tracking.damageEvents.push(hit('Helper',2,20,2,150));p.killFeed[1].t=20;applyAssists(p);assert.equal(p.players.Helper.assists,2);
  p.killFeed.push({...p.killFeed[1]});applyAssists(p);assert.equal(p.players.Helper.assists,2);
});

test('credited void deaths keep assists from combat but remaining HP never creates one',()=>{
  const p=fixture();p.killFeed[0].rawCause='thrown into the void';p.tracking.damageEvents=[hit(),{...hit('Killer',18,20,1,100),method:'credited-void-finish'}];
  applyAssists(p);assert.equal(p.players.Helper.assists,1);assert.equal(p.players.Killer.assists,0);
});

test('duplicate damage packets cannot manufacture an assist from a single HP of damage',()=>{
  const p=fixture(),e=hit('Helper',1);p.tracking.damageEvents=[e,{...e}];applyAssists(p);assert.equal(p.players.Helper.assists,0);
});

test('live packet scoring resolves uncolored White from chat and awards assist plus void HP',()=>{
  const match=createCaptureMatch('1.8.9','assist-packets');let sequence=0,t=0;
  const clock=n=>{t=n;match.updateActionBar({state:'playing',elapsedSec:t,totalSec:600,speed:1});};clock(0);
  const packet=(name,data)=>scorePacket(match,{type:'packet',name,data,sequence:sequence++,receivedMs:t*1000});
  for(const [id,name,prefix,z]of [[1,'Victim','§9',0],[2,'Helper','',2],[3,'Killer','',10]]){
    packet('player_info',{data:[{UUID:name,name}]});packet('scoreboard_team',{team:name,mode:0,prefix,players:[name]});
    packet('named_entity_spawn',{entityId:id,playerUUID:name,x:0,y:2048,z:z*32,yaw:128,pitch:0});
    packet('entity_metadata',{entityId:id,metadata:[{key:6,value:20}]});
  }
  clock(1);packet('animation',{entityId:2,animation:0});packet('entity_status',{entityId:1,entityStatus:2});packet('entity_metadata',{entityId:1,metadata:[{key:6,value:18}]});
  packet('chat',{position:0,message:JSON.stringify({text:'BED DESTRUCTION > Blue Bed was destroyed by §fHelper§r!'})});
  clock(2);packet('entity_teleport',{entityId:2,x:0,y:2048,z:320,yaw:128,pitch:0});packet('entity_teleport',{entityId:3,x:0,y:2048,z:64,yaw:128,pitch:0});
  clock(3);packet('animation',{entityId:3,animation:0});packet('entity_status',{entityId:1,entityStatus:2});packet('entity_metadata',{entityId:1,metadata:[{key:6,value:16}]});
  clock(4);packet('entity_teleport',{entityId:1,x:0,y:-320,z:0});packet('chat',{position:0,message:JSON.stringify({text:'§9Victim §7was thrown into the void by §fKiller§7. FINAL KILL!'})});
  match.updateActionBar({state:'finished',elapsedSec:4,totalSec:600,speed:1});
  const p=match.toJSON();assert.equal(p.players.Helper.assists,1);assert.equal(p.players.Killer.assists,0);
  assert.equal(p.players.Killer.team,'white');assert.equal(p.players.Helper.team,'white');
  assert.equal(p.players.Helper.damageDealt,2);assert.equal(p.players.Killer.damageDealt,18);assert.equal(p.players.Victim.damageReceived,20);
  assert.ok(Number.isInteger(p.killFeed[0].sequence));assert.ok(Number.isInteger(p.killFeed[0].lifeId));
});

test('old damage audits derive assists between recorded deaths and missing audits remain unavailable',()=>{
  const p=fixture();delete p.killFeed[0].sequence;delete p.killFeed[0].lifeId;p.tracking.damageEvents=[hit()];applyAssists(p);assert.equal(p.players.Helper.assists,1);
  const missing=fixture();delete missing.tracking.damageEvents;applyAssists(missing);assert.equal(missing.players.Helper.assists,undefined);
  const invalid=fixture();invalid.tracking.status='invalid';applyAssists(invalid);assert.equal(invalid.players.Helper.assists,undefined);
});

test('name corrections, admin team/kill edits and undo recompute assists without changing recorded evidence',t=>{
  const store=new ReplayStore(':memory:');t.after(()=>store.close());const p=fixture();p.tracking.damageEvents=[hit()];store.importGame(p);
  const raw=store.db.prepare('select payload from games where id=1').get().payload;
  assert.equal(playerStats(store.games(),'Helper').assists,1);assert.equal(gameMatchups(store.getGame(1),'Helper').opponents.find(p=>p.name==='Victim').assists,1);
  store.setGameName(ADMIN_ID,'G1','Helper','Main');store.setGameName(ADMIN_ID,'G1','Victim','Other');
  const renamed=store.getGame(1);assert.equal(renamed.payload.players.Main.assistsByOpponent.Other,1);assert.equal(renamed.payload.tracking.assistEvents[0].helper,'Main');
  const hash=gameCardFingerprint(renamed),edit=store.gameEditor(1);assert.equal(edit.draft.players.find(p=>p.original==='Helper').assists,1);
  edit.draft.players.find(p=>p.original==='Helper').team='blue';let saved=store.saveGameEditor(ADMIN_ID,1,edit.version,edit.draft);
  assert.equal(saved.game.payload.players.Main.assists,0);assert.notEqual(gameCardFingerprint(saved.game),hash);
  store.restoreGameEditor(ADMIN_ID,1,saved.version,saved.history[0].id);assert.equal(store.getGame(1).payload.players.Main.assists,1);
  saved=store.gameEditor(1);saved.draft.killFeed[0].killer='Rival';saved=store.saveGameEditor(ADMIN_ID,1,saved.version,saved.draft);
  assert.equal(saved.game.payload.players.Main.assists,0);assert.equal(store.db.prepare('select payload from games where id=1').get().payload,raw);
});
