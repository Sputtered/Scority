import test from 'node:test';
import assert from 'node:assert/strict';
import {ReplayStore,ADMIN_ID} from '../lib/discord/store.js';
import {playerStats,gameMatchups} from '../lib/discord/stats.js';
import {DiscordUI} from '../lib/discord/ui.js';
import {RecorderBridge} from '../lib/discord/recorder.js';
import {ImageCards} from '../lib/discord/cards/service.js';
import {game} from './fixtures/discord-game.js';

function fixture(t){const store=new ReplayStore(':memory:');t.after(()=>store.close());return store;}
function scored(index,values={}) {
  const payload=game({index});
  Object.assign(payload.players.Sputtered,{damageReceived:20.5,damageDealt:10,damageReceivedAttributed:12,
    damageDealtConfidence:.65,diamondsCollected:4,emeraldsCollected:0,...values});
  payload.tracking={status:'tracked',damageCoverage:.6,damageAccuracy:null,damageEvents:[
    {sequence:10,victim:'Mikowa',attacker:'Sputtered',amount:10,candidates:[{player:'Sputtered'}]}],
    resourceEvents:[{kind:'kill_transfer',victim:'Mikowa',killer:'Sputtered',resource:'diamond',quantity:4},
      {kind:'credit',player:'Sputtered',resource:'diamond',quantity:4}]};
  return payload;
}

test('storage preserves resource evidence; aggregates ignore missing, invalid and retired stats',t=>{
  const store=fixture(t);store.importGame(game({index:1}));
  const first=scored(2),second=scored(3,{damageDealt:30,damageDealtConfidence:.85,diamondsCollected:6,emeraldsCollected:2});
  store.importGame(first);store.importGame(second);
  const invalid=scored(4,{damageReceived:999,damageDealt:999,diamondsCollected:999});invalid.tracking.status='invalid';store.importGame(invalid);
  const raw=store.getGame(2).payload;
  assert.equal(raw.players.Sputtered.damageReceived,20.5);assert.deepEqual(raw.tracking,first.tracking);
  const p=playerStats(store.games(),'Sputtered');
  assert.equal(p.games,4);assert.equal(p.damageReceived,null);assert.equal(p.damageDealt,null);
  assert.equal(p.diamondsCollected,10);assert.equal(p.emeraldsCollected,2);
  assert.equal(p.damageDealtConfidence,undefined);assert.equal(p.damageAccuracy,undefined);
  assert.deepEqual(p.newStatsGames,{diamondsCollected:2,emeraldsCollected:2,assists:0,damageDealt:0,damageReceived:0,diamondsVoided:0,goldenApplesEaten:0,ironSwordLives:0,goldenPickaxeLives:0,ironAxeLives:0,milkBucketLives:0});
  assert.equal(playerStats(store.games(),'Mikowa').diamondsCollected,null);
});

test('identity corrections rename new evidence consistently',t=>{
  const store=fixture(t);store.importGame(scored(1));store.addNameLink(ADMIN_ID,'Sputtered','MainAccount','nick');
  const p=store.getGame(1).payload;
  assert.equal(p.players.MainAccount.damageDealt,10);assert.equal(p.tracking.damageEvents[0].attacker,'MainAccount');
  assert.equal(p.tracking.damageEvents[0].candidates[0].player,'MainAccount');
  assert.equal(p.tracking.resourceEvents[0].killer,'MainAccount');assert.equal(p.tracking.resourceEvents[1].player,'MainAccount');
  store.setGameName(ADMIN_ID,'G1','Mikowa','AnotherMain');
  assert.equal(store.getGame(1).payload.tracking.damageEvents[0].victim,'AnotherMain');
});

test('legacy damage is unavailable in text and images rather than being presented as PvP damage',async t=>{
  const store=fixture(t);store.importGame(scored(1));
  const ui=new DiscordUI(store,new RecorderBridge(store,{log:()=>{}}));
  const cards=new ImageCards({store,avatars:{many:async()=>new Map()},log:()=>{}});
  const profile=ui.render(ADMIN_ID,'stats',{user:'Sputtered'});
  const fields=JSON.stringify(profile.embeds[0].fields);
  assert.ok(profile.embeds[0].fields.some(f=>f.name==='Diamonds' && f.value==='4'));
  assert.ok(profile.embeds[0].fields.some(f=>f.name==='Emeralds' && f.value==='0'));
  assert.doesNotMatch(fields,/confidence|accuracy|5 blocks|credit/i);
  assert.ok(profile.embeds[0].fields.some(f=>f.name==='Damage received' && f.value==='— HP'));
  const first=await cards.decorate(profile);
  assert.ok(first.files?.length);assert.ok(!first.embeds[0].fields.some(f=>/damage|coverage|new stats/i.test(f.name)));
  store.importGame(scored(2,{diamondsCollected:14,damageReceived:30.5}));
  const next=await cards.decorate(ui.render(ADMIN_ID,'stats',{user:'Sputtered'}));
  assert.notDeepEqual(first.files[0].attachment,next.files[0].attachment);
  const gameView=ui.render(ADMIN_ID,'replay',{replay:'G1'});
  assert.match(JSON.stringify(gameView.embeds[0].fields),/—/);
  const before=await cards.decorate(gameView);
  const altered=structuredClone(store.getGame(1));altered.payload.players.Sputtered.diamondsCollected=24;
  const after=await cards.decorate(gameView,{...gameView.cardView,game:altered});
  assert.notDeepEqual(before.files[0].attachment,after.files[0].attachment);
});

test('release damage aggregates only supported games and identity changes preserve opponent totals',async t=>{
  const store=fixture(t);store.importGame(scored(1));
  const payload=scored(2,{damageDealt:10,damageReceived:12,damageByOpponent:{Mikowa:{dealt:10,received:12}}});
  Object.assign(payload.players.Mikowa,{damageDealt:12,damageReceived:10,damageByOpponent:{Sputtered:{dealt:12,received:10}}});
  payload.tracking.damage={version:1,status:'tracked',scope:'attributed-player-damage'};
  store.importGame(payload);
  let p=playerStats(store.games(),'Sputtered');assert.equal(p.damageDealt,10);assert.equal(p.damageReceived,12);assert.equal(p.newStatsGames.damageDealt,1);
  store.addNameLink(ADMIN_ID,'Mikowa','OtherMain','nick');store.addNameLink(ADMIN_ID,'Sputtered','MainAccount','nick');
  const match=gameMatchups(store.getGame(2),'Sputtered');assert.equal(match.damageDealt,10);
  assert.equal(match.opponents[0].name,'OtherMain');assert.equal(match.opponents[0].damageReceived,12);
  assert.equal(store.getGame(2).payload.players.OtherMain.damageByOpponent.MainAccount.received,10);
  const ui=new DiscordUI(store,new RecorderBridge(store,{log:()=>{}})),cards=new ImageCards({store,avatars:{many:async()=>new Map()}});
  const view=ui.render(ADMIN_ID,'gamematchups',{replay:'G2',user:'MainAccount'});
  assert.match(view.embeds[0].fields.find(f=>f.name==='vs OtherMain').value,/10 dealt · 12 received HP/);
  assert.doesNotMatch(JSON.stringify(view.embeds),/experimental/i);
  const image=await cards.decorate(view);assert.equal(image.files.length,1);
});
