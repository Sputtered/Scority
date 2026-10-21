import fs from 'node:fs';
import {ReplayStore, ADMIN_ID} from './store.js';
import {ITEM_STATS, itemUsageTracked} from '../stat-fields.js';
import {ITEM_USAGE_VERSION} from '../item-usage.js';

const integer = value => Number.isSafeInteger(value) && value >= 0;
const fingerprint = payload => ReplayStore.prototype._fingerprint(payload);
const editsFor = (db, id) => db.prepare('SELECT payload FROM game_stat_edits WHERE game_id=?').get(id)?.payload ?? null;

// preserve unrelated stats and metadata
export function mergeItemUsage(previous, scored, {edits = {}} = {}) {
  const tracking = scored.tracking;
  if (!itemUsageTracked(tracking) || tracking.status !== 'tracked' ||
      tracking.itemUsage.version !== ITEM_USAGE_VERSION || tracking.itemUsage.scope !== 'observed-item-use' ||
      scored.match?.endReason !== 'replay_finished' || !Array.isArray(tracking.itemUsageEvents))
    throw Error('A complete current item-usage recording is required');
  if (!previous.match?.replayId || previous.match.replayId.toLowerCase() !== scored.match?.replayId?.toLowerCase() ||
      !Number.isFinite(scored.match.totalDurationSec) || scored.match.totalDurationSec <= 0 ||
      previous.match.totalDurationSec !== scored.match.totalDurationSec)
    throw Error('Replay identity or duration mismatch');
  const names = Object.keys(previous.players ?? {}).sort();
  if (!names.length || JSON.stringify(names) !== JSON.stringify(Object.keys(scored.players ?? {}).sort()))
    throw Error('Player roster mismatch');
  if (Object.entries(tracking.decodeErrors ?? {}).some(([name, count]) => name.startsWith('playing:') && count > 0))
    throw Error('Undecodable playback packets cannot be backfilled');
  const totals = new Map(names.map(name => [name, Object.fromEntries(ITEM_STATS.map(field => [field, 0]))]));
  const seenGear = new Set(), seenEvents = new Set();
  for (const event of tracking.itemUsageEvents) {
    if (!totals.has(event.player) || !ITEM_STATS.includes(event.field) || !integer(event.life) || event.life === 0 ||
        !integer(event.sequence) || !Number.isFinite(event.replaySec) || event.replaySec < 0 || event.replaySec > scored.match.totalDurationSec)
      throw Error('Invalid item-usage evidence');
    const id = JSON.stringify([event.player, event.field, event.sequence]);
    if (seenEvents.has(id)) throw Error('Duplicate item-usage evidence');
    seenEvents.add(id);
    if (event.field !== 'goldenApplesEaten') {
      const life = JSON.stringify([event.player, event.field, event.life]);
      if (seenGear.has(life)) throw Error('Held items can count only once per life');
      seenGear.add(life);
    }
    const deaths = scored.players[event.player].deaths;
    if (integer(deaths) && event.life > deaths + 1) throw Error('Item life exceeds recorded deaths');
    totals.get(event.player)[event.field]++;
  }
  const result = structuredClone(previous), preservedManualStats = [];
  for (const name of names) {
    const player = scored.players[name];
    if (player.team !== previous.players[name].team) throw Error('Player team mismatch');
    for (const field of ITEM_STATS) {
      if (!integer(player[field])) throw Error(`Invalid ${field} for ${name}`);
      if (player[field] !== totals.get(name)[field]) throw Error('Item totals do not match their evidence');
      if (field !== 'goldenApplesEaten' && integer(player.deaths) && player[field] > player.deaths + 1)
        throw Error('Held-item count exceeds recorded lives');
      if (Object.hasOwn(edits.players?.[name] ?? {}, field) || previous.players[name].manualStats?.includes(field)) {
        preservedManualStats.push({player: name, stat: field});
      } else result.players[name][field] = player[field];
    }
  }
  result.tracking ??= {};
  result.tracking.itemUsage = structuredClone(tracking.itemUsage);
  result.tracking.itemUsageEvents = structuredClone(tracking.itemUsageEvents);
  return {payload: result, preservedManualStats};
}

export function planItemUsageBackfill(db, inputs) {
  const seen = new Set();
  return inputs.map(({scored, file = null}) => {
    const replayId = scored.match?.replayId;
    if (typeof replayId !== 'string' || !replayId) throw Error('Scored input is missing its replay ID');
    const row = db.prepare('SELECT * FROM games WHERE replay_id=?').get(replayId);
    if (!row) throw Error('Saved game not found: ' + replayId);
    if (seen.has(row.id)) throw Error('Duplicate game in backfill');
    seen.add(row.id);
    const original = JSON.parse(row.payload), edits = editsFor(db, row.id);
    if (fingerprint(original) !== row.fingerprint) throw Error('Saved game fingerprint does not match its raw evidence');
    const merged = mergeItemUsage({...original, match: {...original.match, replayId: row.replay_id}}, scored,
      {edits: JSON.parse(edits ?? '{}')});
    merged.payload.match = original.match;
    if (fingerprint(merged.payload) !== row.fingerprint) throw Error('Backfill changed the game fingerprint');
    return {row, edits, file, ...merged};
  });
}

export function applyItemUsageBackfill(db, updates, {backup, actor = ADMIN_ID, now = new Date()} = {}) {
  if (!backup) throw Error('Applying a backfill requires a new backup file');
  if (!updates.length) throw Error('No games to backfill');
  const createdAt = now.toISOString();
  fs.writeFileSync(backup, JSON.stringify({schema: 1, kind: 'item-usage-backfill', createdAt,
    games: updates.map(update => update.row),
    manualEdits: updates.map(update => ({gameId: update.row.id, payload: update.edits}))}, null, 2), {flag: 'wx'});
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const update of updates) {
      const {row, payload, edits} = update;
      const current = db.prepare('SELECT * FROM games WHERE id=?').get(row.id);
      if (JSON.stringify(current) !== JSON.stringify(row) || editsFor(db, row.id) !== edits)
        throw Error('Game changed during validation; retry from a new backup');
      if (fingerprint(payload) !== row.fingerprint) throw Error('Backfill changed the game fingerprint');
      db.prepare('UPDATE games SET payload=? WHERE id=?').run(JSON.stringify(payload), row.id);
      db.prepare('INSERT INTO audit(actor,action,detail,created_at) VALUES(?,?,?,?)').run(actor, 'item_usage_backfill',
        JSON.stringify({gameId: row.id, replayId: row.replay_id, version: payload.tracking.itemUsage.version,
          backup, preservedManualStats: update.preservedManualStats}), createdAt);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function summarizeItemUsageBackfill(updates) {
  return updates.map(({row, payload, preservedManualStats}) => ({id: row.id, replayId: row.replay_id,
    version: payload.tracking.itemUsage.version, preservedManualStats,
    players: Object.fromEntries(Object.entries(payload.players).map(([name, player]) =>
      [name, Object.fromEntries(ITEM_STATS.map(field => [field, player[field]]))]))}));
}
