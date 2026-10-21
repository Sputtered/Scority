import fs from 'node:fs';
import {parseArgs} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {planItemUsageBackfill, applyItemUsageBackfill, summarizeItemUsageBackfill} from '../lib/discord/item-usage-backfill.js';

const {values, positionals} = parseArgs({allowPositionals: true, options: {
  database: {type: 'string'}, backup: {type: 'string'}, apply: {type: 'boolean', default: false}
}});
if (!values.database || !fs.existsSync(values.database) || !positionals.length || (values.apply && !values.backup))
  throw Error('Usage: backfill-item-usage.js --database <existing.sqlite> [--apply --backup <new-backup.json>] <scored.json> [...]');
const db = new DatabaseSync(values.database, {readOnly: !values.apply});
try {
  db.exec('PRAGMA busy_timeout=5000');
  const inputs = positionals.map(file => ({file, scored: JSON.parse(fs.readFileSync(file, 'utf8'))}));
  const updates = planItemUsageBackfill(db, inputs);
  if (values.apply) applyItemUsageBackfill(db, updates, {backup: values.backup});
  console.log(JSON.stringify({applied: values.apply, games: summarizeItemUsageBackfill(updates)}, null, 2));
} finally { db.close(); }
