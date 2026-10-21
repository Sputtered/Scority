import test from 'node:test';
import assert from 'node:assert/strict';
import {ReplayStore,ADMIN_ID} from '../lib/discord/store.js';
import {playerStats,gameMatchups} from '../lib/discord/stats.js';
import {visibleStats,extendedLine} from '../lib/stat-fields.js';
import {gameCardFingerprint,gameSnapshot} from '../lib/discord/cards/snapshot.js';
import {ImageCards} from '../lib/discord/cards/service.js';
import {DiscordUI} from '../lib/discord/ui.js';
import {RecorderBridge} from '../lib/discord/recorder.js';
import {game} from './fixtures/discord-game.js';

function tracked(index,value){
  const p=game({index});
  p.players.Sputtered.diamondsVoided=value;p.players.Mikowa.diamondsVoided=0;
  p.tracking={status:'tracked',voidedDiamonds:{version:1,status:'tracked'},resourceEvents:[{kind:'void',player:'Sputtered',resource:'diamond',quantity:value}]};
  return p;
}
function setup(t){const store=new ReplayStore(':memory:');t.after(()=>store.close());return store;}

test('voided diamond totals distinguish tracked zero, unavailable games, and explicit owner edits',t=>{
  const store=setup(t);store.importGame(game({index:1}));
  store.importGame(tracked(2,3));store.importGame(tracked(3,0));
  const unavailable=tracked(4,100);unavailable.tracking.voidedDiamonds.status='unavailable';store.importGame(unavailable);
  const invalid=tracked(5,200);invalid.tracking.status='invalid';store.importGame(invalid);
  let p=playerStats(store.games(),'Sputtered');assert.equal(p.diamondsVoided,3);assert.equal(p.newStatsGames.diamondsVoided,2);
  assert.equal(playerStats([store.getGame(1)],'Sputtered').diamondsVoided,null);
  assert.equal(playerStats(store.games(),'Mikowa').diamondsVoided,0);
  assert.equal(visibleStats(unavailable.players.Sputtered,unavailable.tracking).diamondsVoided,null);
  let edit=store.gameEditor(5);assert.equal(edit.draft.players[0].diamondsVoided,null);
  edit.draft.players[0].diamondsVoided=200;store.saveGameEditor(ADMIN_ID,5,edit.version,edit.draft);
  assert.equal(playerStats(store.games(),'Sputtered').diamondsVoided,203);
  edit=store.gameEditor(5);
  edit.draft.players[0].diamondsVoided=7;store.saveGameEditor(ADMIN_ID,5,edit.version,edit.draft);
  p=playerStats(store.games(),'Sputtered');assert.equal(p.diamondsVoided,10);assert.equal(p.newStatsGames.diamondsVoided,3);
  assert.equal(gameSnapshot(store.getGame(5)).payload.players.Sputtered.diamondsVoided,7);
  edit=store.gameEditor(5);edit.draft.players[0].diamondsVoided=-1;
  assert.throws(()=>store.saveGameEditor(ADMIN_ID,5,edit.version,edit.draft),/whole number/);
});

test('voided diamond evidence follows renamed players and survives rescoring through owner overrides',t=>{
  const store=setup(t),job=store.submit(ADMIN_ID,'void-fixture');store.claimNext();store.complete(job.id,tracked(1,3));
  store.addNameLink(ADMIN_ID,'Sputtered','MainAccount','nick');
  assert.equal(store.getGame(1).payload.tracking.resourceEvents[0].player,'MainAccount');
  assert.equal(gameMatchups(store.getGame(1),'MainAccount').diamondsVoided,3);
  let edit=store.gameEditor(1);edit.draft.players[0].diamondsVoided=9;store.saveGameEditor(ADMIN_ID,1,edit.version,edit.draft);
  store.rescore(ADMIN_ID,'G1');store.claimNext();store.complete(job.id,tracked(1,4));
  assert.equal(store.getGame(1).payload.players.MainAccount.diamondsVoided,9);
  assert.equal(JSON.parse(store.db.prepare('select payload from games where id=1').get().payload).players.Sputtered.diamondsVoided,4);
});

test('voided diamonds appear in text and invalidate card snapshots when quantity or availability changes',async t=>{
  const store=setup(t);store.importGame(tracked(1,3));
  const ui=new DiscordUI(store,new RecorderBridge(store));
  const fields=ui.render(ADMIN_ID,'stats',{user:'Sputtered'}).embeds[0].fields;
  assert.match(fields.find(f=>f.name==='Diamonds voided').value,/3.*1 of 1/);
  const perGame=ui.render(ADMIN_ID,'gamematchups',{replay:'G1',user:'Sputtered'}).embeds[0].fields;
  assert.equal(perGame.find(f=>f.name==='Diamonds voided this game').value,'3');
  const zero=ui.render(ADMIN_ID,'gamematchups',{replay:'G1',user:'Mikowa'}).embeds[0].fields;
  assert.equal(zero.find(f=>f.name==='Diamonds voided this game').value,'0');
  store.importGame(game({index:2}));
  const missing=ui.render(ADMIN_ID,'gamematchups',{replay:'G2',user:'Sputtered'}).embeds[0].fields;
  assert.equal(missing.find(f=>f.name==='Diamonds voided this game').value,'—');
  assert.match(extendedLine(store.getGame(1).payload.players.Sputtered),/3 diamonds voided/);
  const cards=new ImageCards({store,avatars:{many:async()=>new Map()}}),a=store.getGame(1),b=structuredClone(a);
  b.payload.players.Sputtered.diamondsVoided=4;
  assert.notEqual(gameCardFingerprint(a),gameCardFingerprint(b));
  const first=await cards.image('game',gameSnapshot(a),'inventory'),second=await cards.image('game',gameSnapshot(b),'inventory');
  assert.notDeepEqual(first,second);
  b.payload.tracking.voidedDiamonds.status='unavailable';
  assert.equal(gameSnapshot(b).payload.players.Sputtered.diamondsVoided,null);
  assert.notEqual(gameCardFingerprint(a),gameCardFingerprint(b));
});
