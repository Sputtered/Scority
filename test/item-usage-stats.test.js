import test from 'node:test';
import assert from 'node:assert/strict';
import { ITEM_STATS, visibleStats } from '../lib/stat-fields.js';
import { ReplayStore, ADMIN_ID } from '../lib/discord/store.js';
import { playerStats, gameMatchups } from '../lib/discord/stats.js';
import { gameSnapshot, gameCardFingerprint } from '../lib/discord/cards/snapshot.js';
import { game } from './fixtures/discord-game.js';

const values = numbers => Object.fromEntries(ITEM_STATS.map((field, index) => [field, numbers[index] ?? 0]));
function tracked(index, counts = [5, 3, 2, 1]) {
  const p = game({ index });
  p.tracking = { status: 'tracked', itemUsage: { version: 1, status: 'tracked' },
    itemUsageEvents: [{ player: 'Sputtered', kind: 'consume', item: 'golden_apple' }] };
  Object.assign(p.players.Sputtered, values(counts));
  Object.assign(p.players.Mikowa, values([0, 0, 0, 0]));
  return p;
}
function storeFor(t) {
  const s = new ReplayStore(':memory:'); t.after(() => s.close()); return s;
}

test('item counts hide missing, incomplete and invalid evidence while tracked zeros remain visible', () => {
  const player = values([0, 3, 2, 1]);
  for (const tracking of [undefined, { status: 'tracked' }, { itemUsage: { version: 1, status: 'incomplete' } },
    { status: 'invalid', itemUsage: { version: 1, status: 'tracked' } }]) {
    const shown = visibleStats(player, tracking);
    for (const field of ITEM_STATS) assert.equal(shown[field], null);
  }
  const shown = visibleStats(player, tracked(1).tracking);
  for (const field of ITEM_STATS) assert.equal(shown[field], player[field]);
});

test('profiles sum only measured item counts and count a measured zero as a recorded game', t => {
  const s = storeFor(t);
  s.importGame(game({ index: 1 })); s.importGame(tracked(2)); s.importGame(tracked(3, [2, 1, 0, 1]));
  const incomplete = tracked(4, [99, 99, 99, 99]); incomplete.tracking.itemUsage.status = 'incomplete'; s.importGame(incomplete);
  const invalid = tracked(5, [99, 99, 99, 99]); invalid.tracking.status = 'invalid'; s.importGame(invalid);
  const p = playerStats(s.games(), 'Sputtered');
  assert.equal(p.games, 5);
  assert.deepEqual(Object.fromEntries(ITEM_STATS.map(field => [field, p[field]])), values([7, 4, 2, 2]));
  for (const field of ITEM_STATS) {
    assert.equal(p.newStatsGames[field], 2);
    assert.equal(playerStats(s.games(), 'Mikowa')[field], 0);
    assert.equal(playerStats([s.getGame(1)], 'Sputtered')[field], null);
  }
});

test('individual stats and evidence follow name corrections without assigning item totals to opponents', t => {
  const s = storeFor(t); s.importGame(tracked(1));
  s.addNameLink(ADMIN_ID, 'Sputtered', 'MainAccount', 'nick');
  const p = gameMatchups(s.getGame(1), 'Sputtered');
  assert.equal(p.name, 'MainAccount');
  for (const field of ITEM_STATS) {
    assert.equal(p[field], tracked(1).players.Sputtered[field]);
    assert.equal(p.opponents[0][field], undefined);
  }
  assert.equal(s.getGame(1).payload.tracking.itemUsageEvents[0].player, 'MainAccount');
  for (const field of ITEM_STATS) assert.equal(gameMatchups({ id: 2, payload: game() }, 'Sputtered')[field], null);
});

test('card snapshots retain tracking and item values and change cache identity with the counts', t => {
  const s = storeFor(t); s.importGame(tracked(1));
  const g = s.getGame(1), snapshot = gameSnapshot(g);
  assert.equal(snapshot.payload.players.Sputtered.goldenApplesEaten, 5);
  assert.equal(snapshot.payload.tracking.itemUsage.status, 'tracked');
  const before = gameCardFingerprint(g);
  g.payload.players.Sputtered.goldenApplesEaten++;
  assert.notEqual(gameCardFingerprint(g), before);
  g.payload.tracking.itemUsage.status = 'incomplete';
  assert.equal(gameSnapshot(g).payload.players.Sputtered.goldenApplesEaten, null);
});
