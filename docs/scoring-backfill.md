# Backfill damage and resource scoring

Use a complete saved packet capture to recalculate damage, collected resources
and diamonds voided. Earlier games are not changed automatically.

First score each capture into a new JSON file:

```sh
node scripts/score-capture.js captures/<capture>/packets.jsonl.gz <new-scored.json>
```

Review a dry run against the existing database:

```sh
node scripts/backfill-scoring.js --database data/replays.sqlite <new-scored.json>
```

The default opens SQLite read-only. It verifies replay ID, duration, exact raw
roster and teams, a finished replay, current damage/resource versions, and
tracked void evidence. Damage and void totals must agree with their event
evidence. It rejects undecodable playback packets. The output lists resulting
statistics and manual resource fields that will be preserved.
If merged stack amounts are unresolved, affected collected-resource totals stay
unavailable (`null`); `tracking.unresolvedResourceAmounts` retains the reason.

Apply the reviewed inputs with a new backup filename:

```sh
node scripts/backfill-scoring.js --database data/replays.sqlite --apply --backup <new-backup.json> <new-scored.json> [<another-scored.json>]
```

The backup records the original game rows and manual stat edits. An existing
backup file is never overwritten. All games apply in one transaction; if any
saved row or manual stat edit changed after validation, the entire batch rolls
back. Each updated game receives an audit entry. Backups remain available if
the transaction fails.

Only damage, resource statistics and their tracking evidence are replaced.
Game IDs, recorded dates, fingerprint, raw match metadata, kills, beds, upgrades,
name corrections, winner overrides and separate manual edits remain intact.
Manually overridden resource fields are skipped. Assists continue to be derived
from the preserved kill feed and new damage evidence when the game is read.

The narrower `backfill-player-damage.js` remains available for damage-only work.
Neither command records a new replay or publishes Discord messages.
