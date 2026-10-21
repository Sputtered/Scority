import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ReplayStore} from '../lib/discord/store.js';
import {mergeScoring,planScoringBackfill,applyScoringBackfill} from '../lib/discord/scoring-backfill.js';
import {game} from './fixtures/discord-game.js';

function fixture(index=1){
  const original=game({index});original.match.replayId=`backfill-${index}`;
  original.players.Sputtered.diamondsCollected=2;
  const scored=structuredClone(original);
  Object.assign(scored.players.Sputtered,{damageDealt:12,damageReceived:3,damageByOpponent:{Mikowa:{dealt:12,received:3}},diamondsVoided:4});
  Object.assign(scored.players.Mikowa,{damageDealt:3,damageReceived:12,damageByOpponent:{Sputtered:{dealt:3,received:12}},diamondsVoided:0});
  for(const p of Object.values(scored.players))Object.assign(p,{diamondsCollected:8,emeraldsCollected:2,
    resourceCarried:{diamond:0,emerald:0},resourcePickups:{diamond:12,emerald:2}});
  scored.tracking={version:4,status:'tracked',protocolVersion:'1.8.9',damage:{version:2,status:'tracked',scope:'attributed-player-damage'},
    damageEvents:[{sequence:10,t:10,victim:'Mikowa',attacker:'Sputtered',healthLoss:12},
      {sequence:20,t:20,victim:'Sputtered',attacker:'Mikowa',healthLoss:3}],
    resourceVersion:2,voidedDiamonds:{version:1,status:'tracked'},
    resourceEvents:[{kind:'void',resource:'diamond',player:'Sputtered',quantity:4}],
    resourceRule:'test rule',decodeErrors:{},chunkErrors:[],issues:[],playbackSpeeds:[1],enderChests:[],unresolvedCollections:0};
  return {original,scored};
}
function temporary(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scority-backfill-'));
  t.after(()=>{if(path.dirname(dir)!==path.resolve(os.tmpdir()))throw Error('Unexpected temporary path');fs.rmSync(dir,{recursive:true,force:true});});
  return dir;
}
function memory(t){const store=new ReplayStore(':memory:');t.after(()=>store.close());return store;}

test('scoring merge changes only extended stats and evidence, preserving embedded manual resources',()=>{
  const {original,scored}=fixture(),snapshot=structuredClone(original);
  original.players.Sputtered.manualStats=['diamondsCollected'];
  scored.match.winner='green';scored.killFeed=[];scored.bedBreaks=[];scored.players.Sputtered.kills=999;
  const {payload,preservedManualStats}=mergeScoring(original,scored);
  assert.deepEqual(payload.match,original.match);assert.deepEqual(payload.killFeed,original.killFeed);assert.deepEqual(payload.bedBreaks,original.bedBreaks);
  assert.equal(payload.players.Sputtered.kills,original.players.Sputtered.kills);
  assert.equal(payload.players.Sputtered.diamondsCollected,2);assert.equal(payload.players.Sputtered.diamondsVoided,4);
  assert.equal(payload.players.Sputtered.damageDealt,12);
  assert.deepEqual(preservedManualStats,[{player:'Sputtered',stat:'diamondsCollected'}]);
  delete original.players.Sputtered.manualStats;assert.deepEqual(original,snapshot);
});

test('scoring merge rejects incomplete, obsolete, malformed and inconsistent evidence',()=>{
  for(const mutate of [s=>s.match.endReason='interrupted',s=>s.tracking.damage.version=1,s=>s.tracking.voidedDiamonds.status='incomplete',
    s=>s.tracking.resourceVersion=1,s=>s.tracking.decodeErrors={'playing:entity_metadata':1},
    s=>s.players.Mikowa.diamondsVoided=-1,s=>s.players.Mikowa.emeraldsCollected=1.5,
    s=>s.players.Mikowa.resourcePickups.diamond=NaN,s=>s.tracking.damageEvents=[],s=>s.tracking.resourceEvents=[]]){
    const {original,scored}=fixture();mutate(scored);assert.throws(()=>mergeScoring(original,scored));
  }
});

test('uncertain merged-stack collection totals stay null during backfill',()=>{
  const {original,scored}=fixture();scored.tracking.unresolvedResourceAmounts=['diamond'];
  assert.throws(()=>mergeScoring(original,scored),/must stay unavailable/);
  for(const player of Object.values(scored.players))player.diamondsCollected=null;
  const {payload}=mergeScoring(original,scored);
  assert.equal(payload.players.Sputtered.diamondsCollected,null);
  assert.equal(payload.players.Mikowa.diamondsCollected,null);
  assert.equal(payload.players.Sputtered.diamondsVoided,4);
  assert.deepEqual(payload.tracking.unresolvedResourceAmounts,['diamond']);
});

test('a tracked game can backfill unavailable void totals for an unobserved player without inventing zero',()=>{
  const {original,scored}=fixture();scored.players.Mikowa.diamondsVoided=null;
  const {payload}=mergeScoring(original,scored);
  assert.equal(payload.players.Mikowa.diamondsVoided,null);
  assert.equal(payload.players.Sputtered.diamondsVoided,4);
  scored.players.Sputtered.diamondsVoided=null;
  assert.throws(()=>mergeScoring(original,scored),/Voided diamond totals do not match/);
});

test('transactional scoring backfill preserves IDs, fingerprint, winner, names and separate manual edits',t=>{
  const dir=temporary(t),store=memory(t),{original,scored}=fixture();
  const id=store.importGame(original);
  store.db.prepare('UPDATE games SET winner_reviewed=1,winner_override=? WHERE id=?').run('green',id);
  const edits=JSON.stringify({players:{Sputtered:{diamondsCollected:99,diamondsVoided:7,kills:15}}});
  store.db.prepare('INSERT INTO game_stat_edits VALUES(?,?)').run(id,edits);
  store.db.prepare('INSERT INTO game_names VALUES(?,?,?)').run(id,'Sputtered','Renamed');
  const before=store.db.prepare('SELECT * FROM games WHERE id=?').get(id);
  const plan=planScoringBackfill(store.db,[{scored}]),backup=path.join(dir,'backup.json');
  applyScoringBackfill(store.db,plan,{backup});
  const after=store.db.prepare('SELECT * FROM games WHERE id=?').get(id);
  assert.deepEqual({...after,payload:null},{...before,payload:null});
  const raw=JSON.parse(after.payload);assert.deepEqual(raw.match,original.match);assert.deepEqual(raw.killFeed,original.killFeed);
  assert.equal(raw.players.Sputtered.damageDealt,12);assert.equal(raw.players.Sputtered.diamondsCollected,2);
  assert.equal(store.db.prepare('SELECT payload FROM game_stat_edits WHERE game_id=?').get(id).payload,edits);
  const displayed=store.getGame(id);assert.equal(displayed.payload.match.winner,'green');
  assert.equal(displayed.payload.players.Renamed.diamondsCollected,99);assert.equal(displayed.payload.players.Renamed.diamondsVoided,7);
  assert.equal(displayed.payload.players.Renamed.kills,15);assert.equal(displayed.payload.players.Renamed.damageDealt,12);
  assert.equal(JSON.parse(fs.readFileSync(backup)).games[0].payload,before.payload);
  assert.equal(store.audit().filter(a=>a.action==='scoring_backfill').length,1);
});

test('a concurrent change rolls back every game and audit entry in a scoring batch',t=>{
  const dir=temporary(t),store=memory(t),a=fixture(1),b=fixture(2);
  const aid=store.importGame(a.original),bid=store.importGame(b.original);
  const before=store.db.prepare('SELECT payload FROM games WHERE id=?').get(aid).payload;
  const plan=planScoringBackfill(store.db,[{scored:a.scored},{scored:b.scored}]);
  store.db.prepare('INSERT INTO game_stat_edits VALUES(?,?)').run(bid,JSON.stringify({players:{Mikowa:{diamondsCollected:20}}}));
  assert.throws(()=>applyScoringBackfill(store.db,plan,{backup:path.join(dir,'backup.json')}),/changed during validation/);
  assert.equal(store.db.prepare('SELECT payload FROM games WHERE id=?').get(aid).payload,before);
  assert.equal(store.audit().filter(a=>a.action==='scoring_backfill').length,0);
});

test('backfill refuses duplicate games, missing backup and existing backup files before writing scores',t=>{
  const dir=temporary(t),store=memory(t),{original,scored}=fixture();store.importGame(original);
  assert.throws(()=>planScoringBackfill(store.db,[{scored},{scored}]),/Duplicate/);
  const plan=planScoringBackfill(store.db,[{scored}]),backup=path.join(dir,'existing.json');
  assert.throws(()=>applyScoringBackfill(store.db,plan),/backup/);
  fs.writeFileSync(backup,'keep');assert.throws(()=>applyScoringBackfill(store.db,plan,{backup}),/EEXIST/);
  assert.equal(fs.readFileSync(backup,'utf8'),'keep');assert.equal(store.audit().length,0);
});

test('backfill CLI defaults to a read-only dry run with no new backup or score writes',t=>{
  const dir=temporary(t),database=path.join(dir,'replays.sqlite'),file=path.join(dir,'scored.json');
  const {original,scored}=fixture();let store=new ReplayStore(database);store.importGame(original);store.close();
  const before=fs.readFileSync(database);fs.writeFileSync(file,JSON.stringify(scored));
  const result=spawnSync(process.execPath,['scripts/backfill-scoring.js','--database',database,file],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).applied,false);
  assert.deepEqual(fs.readFileSync(database),before);
  assert.deepEqual(fs.readdirSync(dir).filter(name=>name.endsWith('.json')),['scored.json']);
});
