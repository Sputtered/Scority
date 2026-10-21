import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ReplayStore} from '../lib/discord/store.js';
import {ITEM_STATS} from '../lib/stat-fields.js';
import {mergeItemUsage, planItemUsageBackfill, applyItemUsageBackfill} from '../lib/discord/item-usage-backfill.js';
import {game} from './fixtures/discord-game.js';

function fixture(index = 1) {
  const original = game({index}); original.match.replayId = `item-backfill-${index}`;
  original.tracking = {status: 'tracked', damage: {version: 2, status: 'tracked'}, resourceEvents: [{kind: 'test'}]};
  original.teamUpgrades = {status: 'estimated'};
  const scored = structuredClone(original);
  for (const player of Object.values(scored.players)) Object.assign(player, Object.fromEntries(ITEM_STATS.map(field => [field, 0])));
  Object.assign(scored.players.Sputtered, {goldenApplesEaten: 2, ironSwordLives: 1, goldenPickaxeLives: 1});
  scored.players.Mikowa.ironAxeLives = 1;
  scored.players.Mikowa.milkBucketLives = 1;
  scored.tracking.itemUsage = {version: 1, status: 'tracked', scope: 'observed-item-use'};
  scored.tracking.itemUsageEvents = [
    {player: 'Sputtered', field: 'goldenApplesEaten', life: 1, sequence: 10, replaySec: 2},
    {player: 'Sputtered', field: 'goldenApplesEaten', life: 1, sequence: 20, replaySec: 5},
    {player: 'Sputtered', field: 'ironSwordLives', life: 1, sequence: 30, replaySec: 7},
    {player: 'Sputtered', field: 'goldenPickaxeLives', life: 2, sequence: 40, replaySec: 100},
    {player: 'Mikowa', field: 'ironAxeLives', life: 1, sequence: 50, replaySec: 150},
    {player: 'Mikowa', field: 'milkBucketLives', life: 1, sequence: 60, replaySec: 180}
  ];
  return {original, scored};
}
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scority-item-backfill-'));
  t.after(() => {
    if (path.dirname(dir) !== path.resolve(os.tmpdir())) throw Error('Unexpected temporary path');
    fs.rmSync(dir, {recursive: true, force: true});
  });
  return dir;
}
function memory(t) { const store = new ReplayStore(':memory:'); t.after(() => store.close()); return store; }

test('item merge changes only its five counts and evidence and leaves inputs intact', () => {
  const {original, scored} = fixture(), snapshot = structuredClone(original);
  scored.match.winner = 'green'; scored.killFeed = []; scored.bedBreaks = [];
  scored.teamUpgrades = {}; scored.players.Sputtered.kills = 999; scored.tracking.damage = {};
  const {payload} = mergeItemUsage(original, scored);
  assert.deepEqual(original, snapshot);
  const expected = structuredClone(original);
  for (const name of Object.keys(expected.players)) for (const field of ITEM_STATS) expected.players[name][field] = scored.players[name][field];
  expected.tracking.itemUsage = scored.tracking.itemUsage;
  expected.tracking.itemUsageEvents = scored.tracking.itemUsageEvents;
  assert.deepEqual(payload, expected);
});

test('item backfill rejects wrong identity, incomplete tracking and invalid or unsupported totals', () => {
  for (const mutate of [
    s => s.match.replayId = 'wrong', s => s.match.totalDurationSec++, s => delete s.players.Mikowa,
    s => s.players.Mikowa.team = 'red', s => s.match.endReason = 'interrupted',
    s => s.tracking.status = 'invalid', s => s.tracking.itemUsage.status = 'unavailable',
    s => s.tracking.itemUsage.version = 0, s => s.tracking.itemUsage.scope = 'inventory',
    s => s.tracking.decodeErrors = {'playing:entity_equipment': 1},
    s => s.players.Sputtered.goldenApplesEaten = -1, s => s.players.Sputtered.ironSwordLives = 0.5,
    s => s.players.Mikowa.ironAxeLives = null, s => s.players.Mikowa.goldenApplesEaten = Number.MAX_SAFE_INTEGER + 1,
    s => s.players.Mikowa.milkBucketLives = -1,
    s => s.tracking.itemUsageEvents = [], s => s.tracking.itemUsageEvents[0].player = 'Unknown',
    s => s.tracking.itemUsageEvents[0].life = 99, s => s.tracking.itemUsageEvents[0].sequence = -1,
    s => s.tracking.itemUsageEvents[0].replaySec = 700,
    s => s.tracking.itemUsageEvents.push({...s.tracking.itemUsageEvents[0]}),
    s => { s.players.Sputtered.ironSwordLives++; s.tracking.itemUsageEvents.push({...s.tracking.itemUsageEvents[2], sequence: 80}); },
    s => { s.players.Mikowa.milkBucketLives++; s.tracking.itemUsageEvents.push({...s.tracking.itemUsageEvents[5], sequence: 90}); }
  ]) {
    const {original, scored} = fixture(); mutate(scored); assert.throws(() => mergeItemUsage(original, scored));
  }
});

test('life bounds use fresh score deaths and preserve old manual item counts', () => {
  const {original, scored} = fixture(); original.players.Sputtered.deaths = 0;
  original.players.Sputtered.goldenApplesEaten = 99;
  original.players.Sputtered.manualStats = ['goldenApplesEaten'];
  const {payload, preservedManualStats} = mergeItemUsage(original, scored);
  assert.equal(payload.players.Sputtered.deaths, 0);
  assert.equal(payload.players.Sputtered.goldenApplesEaten, 99);
  assert.equal(payload.players.Sputtered.goldenPickaxeLives, 1);
  assert.deepEqual(preservedManualStats, [{player: 'Sputtered', stat: 'goldenApplesEaten'}]);
});

test('transactional item backfill preserves metadata, winner, identities and separate edits', t => {
  const dir = temporary(t), store = memory(t), {original, scored} = fixture();
  const id = store.importGame(original);
  store.db.prepare('UPDATE games SET winner_reviewed=1,winner_override=? WHERE id=?').run('green', id);
  const edits = JSON.stringify({players: {Sputtered: {goldenApplesEaten: 99, kills: 15}}});
  store.db.prepare('INSERT INTO game_stat_edits VALUES(?,?)').run(id, edits);
  store.db.prepare('INSERT INTO game_names VALUES(?,?,?)').run(id, 'Sputtered', 'Renamed');
  const before = store.db.prepare('SELECT * FROM games WHERE id=?').get(id);
  const plan = planItemUsageBackfill(store.db, [{scored}]), backup = path.join(dir, 'backup.json');
  applyItemUsageBackfill(store.db, plan, {backup});
  const after = store.db.prepare('SELECT * FROM games WHERE id=?').get(id);
  assert.deepEqual({...after, payload: null}, {...before, payload: null});
  assert.equal(store.db.prepare('SELECT payload FROM game_stat_edits WHERE game_id=?').get(id).payload, edits);
  assert.deepEqual({...store.db.prepare('SELECT original,main FROM game_names WHERE game_id=?').get(id)}, {original: 'Sputtered', main: 'Renamed'});
  const raw = JSON.parse(after.payload);
  assert.deepEqual(raw.match, original.match); assert.deepEqual(raw.killFeed, original.killFeed);
  assert.equal(raw.players.Sputtered.ironSwordLives, 1);
  assert.equal(raw.players.Sputtered.goldenApplesEaten, undefined);
  assert.equal(JSON.parse(fs.readFileSync(backup)).games[0].payload, before.payload);
  assert.equal(store.audit().filter(a => a.action === 'item_usage_backfill').length, 1);
});

test('concurrent manual edits roll back every game and audit entry in an item batch', t => {
  const dir = temporary(t), store = memory(t), a = fixture(1), b = fixture(2);
  const aid = store.importGame(a.original), bid = store.importGame(b.original);
  const before = store.db.prepare('SELECT payload FROM games WHERE id=?').get(aid).payload;
  const plan = planItemUsageBackfill(store.db, [{scored: a.scored}, {scored: b.scored}]);
  store.db.prepare('INSERT INTO game_stat_edits VALUES(?,?)').run(bid, JSON.stringify({players: {Mikowa: {kills: 20}}}));
  assert.throws(() => applyItemUsageBackfill(store.db, plan, {backup: path.join(dir, 'backup.json')}), /changed during validation/);
  assert.equal(store.db.prepare('SELECT payload FROM games WHERE id=?').get(aid).payload, before);
  assert.equal(store.audit().filter(a => a.action === 'item_usage_backfill').length, 0);
});

test('item backfill requires unique games and a new backup file', t => {
  const dir = temporary(t), store = memory(t), {original, scored} = fixture(); store.importGame(original);
  assert.throws(() => planItemUsageBackfill(store.db, [{scored}, {scored}]), /Duplicate/);
  const plan = planItemUsageBackfill(store.db, [{scored}]), backup = path.join(dir, 'existing.json');
  assert.throws(() => applyItemUsageBackfill(store.db, plan), /backup/);
  fs.writeFileSync(backup, 'keep'); assert.throws(() => applyItemUsageBackfill(store.db, plan, {backup}), /EEXIST/);
  assert.equal(fs.readFileSync(backup, 'utf8'), 'keep'); assert.equal(store.audit().length, 0);
});

test('item backfill CLI defaults to a read-only dry run', t => {
  const dir = temporary(t), database = path.join(dir, 'replays.sqlite'), file = path.join(dir, 'scored.json');
  const {original, scored} = fixture(); const store = new ReplayStore(database); store.importGame(original); store.close();
  const before = fs.readFileSync(database); fs.writeFileSync(file, JSON.stringify(scored));
  const result = spawnSync(process.execPath, ['scripts/backfill-item-usage.js', '--database', database, file], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).applied, false);
  assert.deepEqual(fs.readFileSync(database), before);
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.json')), ['scored.json']);
});
