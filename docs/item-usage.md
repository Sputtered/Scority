# Item usage

Game cards show five small Minecraft item icons with counts beside each player
name. Player profiles and individual game cards use the same icon group beside
the heading. The text view explains the five counts.

| Field | Meaning |
| --- | --- |
| `goldenApplesEaten` | Observed completed golden-apple uses. |
| `ironSwordLives` | Distinct lives where the player was seen holding an iron sword. |
| `goldenPickaxeLives` | Distinct lives where the player was seen holding a golden pickaxe. |
| `ironAxeLives` | Distinct lives where the player was seen holding an iron axe. |
| `milkBucketLives` | Distinct lives where the player was seen holding a milk bucket. |

The 1.8.9 replay sends entity status 9 when an item use finishes. It is counted
as an apple only when the observed held item is a golden apple. Equipping or
switching away from an apple does not count as eating one. The same event is
also used for other consumables, which are excluded.

Equipment is counted once per item, per life. Repeated switches to the same
tool do not add to the count. A player disappearing from view or respawning as
a visible entity is not enough to start another life; recorded death evidence
is required. These values measure items seen in hand, so an item that stays
hidden in a player's inventory cannot be counted.

`tracking.itemUsage` records support and completeness independently of resource
and damage tracking. Missing, unsupported, partial, or invalid recordings show
a dash. Tracked zero values stay zero. Profile totals include only supported
recordings, and `newStatsGames` records the coverage for each item field.

New recordings include these fields automatically. Historical complete packet
captures can be rescored and merged with `scripts/backfill-item-usage.js`.
The merge copies only item counts and their evidence, preserving existing game
stats, names, overrides, and chronology. The command defaults to a dry run and
requires a new backup file with `--apply`.

```sh
node scripts/score-capture.js path/to/packets.jsonl.gz path/to/scored.json
node scripts/backfill-item-usage.js --database data/replays.sqlite path/to/scored.json
node scripts/backfill-item-usage.js --database data/replays.sqlite --apply --backup item-usage-backup.json path/to/scored.json
```
