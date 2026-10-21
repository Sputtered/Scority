import test from 'node:test';
import assert from 'node:assert/strict';
import {ReplayStore,ADMIN_ID} from '../lib/discord/store.js';
import {matchup,gameMatchups,playerStats,playerGames,teammates,rivals,leaderboard} from '../lib/discord/stats.js';
import {game} from './fixtures/discord-game.js';
function fixture(t) { const s=new ReplayStore(':memory:'); t.after(()=>s.close()); return s; }
test('Sputtered vs Mikowa: 3 wins 1 loss with direct kills/deaths',t=>{
  const s=fixture(t);
  for(let i=1;i<=4;i++) s.importGame(game({index:i,winner:i===4?'green':'red'}));
  const p=matchup(s.games(),'sputtered','MIKOWA');
  assert.equal(p.wins,3); assert.equal(p.losses,1); assert.equal(p.kills,8); assert.equal(p.deaths,4);
  const inverse=matchup(s.games(),'mikowa','Sputtered');
  assert.equal(inverse.wins,1); assert.equal(inverse.kills,4); assert.equal(inverse.deaths,8);
  assert.equal(playerGames(s.games(),'sPutTeReD').length,4);
});
test('matchups exclude teammates and unknown teams; unknown winners do not become losses',t=>{
  const s=fixture(t);
  s.importGame(game({index:1,winner:null}));
  s.importGame(game({index:2,bobTeam:'red'}));
  s.importGame(game({index:3,aliceTeam:null}));
  const p=matchup(s.games(),'Sputtered','Mikowa');
  assert.equal(p.games,1); assert.equal(p.unknown,1); assert.equal(p.losses,0);
  assert.equal(p.teammateGames,1); assert.equal(p.unassignedGames,1);
  assert.equal(teammates(s.games(),'Sputtered')[0].games,1);
  assert.equal(rivals(s.games(),'Sputtered')[0].games,1);
});
test('owner winner corrections update aggregates and leaderboard',t=>{
  const s=fixture(t); const id=s.importGame(game());
  assert.equal(playerStats(s.games(),'Sputtered').wins,1);
  s.setWinner(ADMIN_ID,`G${id}`,'green');
  assert.equal(playerStats(s.games(),'Sputtered').losses,1);
  assert.equal(leaderboard(s.games(),'wl')[0].name,'Mikowa');
  assert.deepEqual(leaderboard(s.games(),'wl',2),[]);
});
test('player W/L uses wins divided by losses and excludes games without a result',t=>{
  const s=fixture(t);
  assert.equal(playerStats(s.games(),'Sputtered').wl,0);
  s.importGame(game({index:1}));assert.equal(playerStats(s.games(),'Sputtered').wl,1);
  s.importGame(game({index:2}));s.importGame(game({index:3}));
  s.importGame(game({index:4,winner:'green'}));s.importGame(game({index:5,winner:null}));
  const p=playerStats(s.games(),'Sputtered');assert.equal(p.wl,3);assert.equal(p.winrate,75);
  assert.equal(playerStats(s.games(),'Mikowa').wl,0.33);
});
test('game matchups count direct fights only in that replay and include zero-contact opponents',t=>{
  const s=fixture(t),payload=game();
  payload.players.Teammate={team:'red',kills:20,deaths:20};payload.players.Silent={team:'green',kills:0,deaths:0};
  payload.players.Unplaced={team:null,kills:20,deaths:20};
  payload.killFeed.push({killer:'Teammate',victim:'Sputtered'},{killer:'Sputtered',victim:'Teammate'},
    {killer:null,victim:'Sputtered'},{killer:'Sputtered',victim:'Unplaced'},{killer:'Unplaced',victim:'Sputtered'});
  s.importGame(payload);s.importGame(game({index:2,kills:100,deaths:50}));
  const p=gameMatchups(s.getGame(1),'sputtered');
  assert.equal(p.kills,2);assert.equal(p.deaths,1);assert.equal(p.kd,2);assert.equal(p.unassignedCount,1);
  assert.deepEqual(p.opponents.map(({name,kills,deaths,kd})=>({name,kills,deaths,kd})),[
    {name:'Mikowa',kills:2,deaths:1,kd:2},{name:'Silent',kills:0,deaths:0,kd:0}]);
  const inverse=gameMatchups(s.getGame(1),'Mikowa').opponents.find(p=>p.name==='Sputtered');
  assert.equal(inverse.kills,1);assert.equal(inverse.deaths,2);assert.equal(inverse.kd,0.5);
});
test('player detail keeps full game deaths while opponent rows exclude environmental deaths',t=>{
  const s=fixture(t),payload=game({deaths:1});
  payload.players.Sputtered.deaths++;
  payload.killFeed.push({t:500,killer:null,victim:'Sputtered',cause:'void'});
  s.importGame(payload);
  const p=gameMatchups(s.getGame(1),'Sputtered');
  assert.equal(p.gameTotals.deaths,2);assert.equal(p.deaths,1);
  assert.equal(p.opponents.reduce((n,o)=>n+o.deaths,0),1);
  assert.equal(p.gameTotals.kills,payload.players.Sputtered.kills);
});

test('game matchup selections follow original names through global and per-game corrections',t=>{
  const s=fixture(t);s.importGame(game({deaths:0}));s.addNameLink(ADMIN_ID,'Sputtered','MainAccount','nick');
  let p=gameMatchups(s.getGame(1),'Sputtered');assert.equal(p.name,'MainAccount');assert.equal(p.kd,2);
  s.setGameName(ADMIN_ID,'G1','Sputtered','SharedAltUser');
  p=gameMatchups(s.getGame(1),'sputtered');assert.equal(p.name,'SharedAltUser');assert.equal(p.opponents[0].kills,2);
  s.setGameName(ADMIN_ID,'G1','Mikowa','OtherMain');
  assert.equal(gameMatchups(s.getGame(1),'Sputtered').opponents[0].name,'OtherMain');
});
test('game matchups refuse conflicting names, missing players, and unknown player teams',t=>{
  const s=fixture(t);s.importGame(game({aliceTeam:null}));
  assert.throws(()=>gameMatchups(s.getGame(1),'Sputtered'),/team was not recorded/);
  assert.throws(()=>gameMatchups(s.getGame(1),'AbsentPlayer'),/no longer listed/);
  s.addNameLink(ADMIN_ID,'Nick','Mikowa','nick');
  const payload=JSON.parse(JSON.stringify(game({index:2})).replaceAll('Sputtered','Nick'));s.importGame(payload);
  assert.throws(()=>gameMatchups(s.getGame(2),'Nick'),/fix.*name links/);
});

test('ratio leaderboards stop at ten and sort finite ratios, ties, zero and minimum games consistently',()=>{
  const players=Object.fromEntries(Array.from({length:12},(_,i)=>[`Player${String(i).padStart(2,'0')}`,{team:'red',kills:i,deaths:i===11?0:1}]));
  const games=[{payload:{players,match:{winner:'red'}}}];
  const kd=leaderboard(games,'kd');
  assert.equal(kd.length,10);assert.equal(kd[0].name,'Player11');assert.equal(kd[0].kd,11);
  assert.equal(kd[1].name,'Player10');assert.equal(kd[9].name,'Player02');
  const wl=leaderboard(games,'wl');assert.equal(wl.length,10);assert.equal(wl[0].name,'Player00');
  assert.ok(wl.every(p=>p.wl===1));assert.deepEqual(leaderboard(games,'kd',2),[]);
  const zero=[{payload:{players:{Zero:{team:'green',kills:0,deaths:0}},match:{winner:'red'}}}];
  assert.equal(leaderboard(zero,'kd')[0].kd,0);assert.equal(leaderboard(zero,'wl')[0].wl,0);
  assert.throws(()=>leaderboard(games,'wins'),/Choose K\/D ratio/);
});

test('zero deaths and losses give finite ratios across profiles and both matchup views',t=>{
  const s=fixture(t);s.importGame(game({kills:1,deaths:0}));
  const player=playerStats(s.games(),'Sputtered');
  assert.equal(player.kd,1);assert.equal(player.wl,1);
  assert.equal(matchup(s.games(),'Sputtered','Mikowa').kd,1);
  const single=gameMatchups(s.getGame(1),'Sputtered');assert.equal(single.kd,1);assert.equal(single.opponents[0].kd,1);
  s.importGame(game({index:2,kills:4,deaths:0}));
  assert.equal(playerStats(s.games(),'Sputtered').kd,5);assert.equal(playerStats(s.games(),'Sputtered').wl,2);
  assert.equal(leaderboard(s.games(),'kd')[0].kd,5);assert.equal(leaderboard(s.games(),'wl')[0].wl,2);
  assert.equal(playerStats(s.games(),'Mikowa').wl,0);
  assert.doesNotMatch(JSON.stringify(player),/"kd":null|"wl":null/);
});

test('voided games leave every aggregate and restore without losing names or winner edits',t=>{
  const s=fixture(t);s.importGame(game());s.setVoided(ADMIN_ID,'G1',true,'Test');
  assert.equal(playerStats(s.games(),'Sputtered').games,0);assert.equal(matchup(s.games(),'Sputtered','Mikowa').games,0);
  assert.deepEqual(leaderboard(s.games()),[]);assert.deepEqual(rivals(s.games(),'Sputtered'),[]);assert.deepEqual(teammates(s.games(),'Sputtered'),[]);
  assert.equal(playerGames(s.games(),'Sputtered').length,1);assert.throws(()=>gameMatchups(s.getGame(1),'Sputtered'),/voided/);
  s.addNameLink(ADMIN_ID,'Sputtered','MainAccount','nick');s.setWinner(ADMIN_ID,'G1','green');
  s.setVoided(ADMIN_ID,'G1',false);const p=playerStats(s.games(),'MainAccount');assert.equal(p.games,1);assert.equal(p.losses,1);
  assert.equal(leaderboard(s.games(),'wl')[0].name,'Mikowa');
});
