# Player damage

Normal recordings include `damageDealt`, `damageReceived` and
`damageByOpponent` in HP (2 HP = 1 heart). Inventory game cards show the two
damage columns; Game matchups opens a player detail card with opponent damage.
The original Minecraft bitmap atlas renders numbers and display headings.
Career totals count only games with the released player-damage schema. Older
games show a dash until recorded again or backfilled from a complete capture.

Observed health loss is attributed using opposing teams, hurt signals, swings,
yaw, pitch and a 4.5-block allowance. A single nearby aimed opponent can supply
an attribution without a matched swing. This allowance is not a ping measurement.
Version 2 matches signals by replay-scaled arrival time; packet order resolves
equal timestamps. Unrelated packet traffic does not change the matching window.
Each health loss needs exactly one matched hurt, and a swing can support only one
attributed loss. Multiple hurts sharing a health update remain unassigned.
Geometry uses the victim and roster at the hurt signal and the attacker at the
matched swing, so movement before delayed health metadata does not erase a hit.
Events retain these positions for review. Life IDs also prevent signals from
crossing a death and respawn when an entity ID is reused.
Ambiguous losses, solo falls and uncredited void deaths do not count as PvP.
Attribution is inferred from replay evidence, not an independently verified
server damage ledger. Missing health updates, absorption and projectiles can
leave damage uncounted; no numeric accuracy claim is made.

For a server-credited void kill, the last known remaining HP is charged once to
the killer's dealt damage and the victim's received damage. Void is evidenced by
a below-zero victim position or explicit void death wording. Health loss already
observed during that same fall is assigned to that killer, without duplicating
it. A terminal zero before chat and a zero after chat are handled separately.
Unknown HP is never replaced with an assumed 20. Teams, life identity, entity
generation and duplicate-death guards prevent credit crossing lives or players.
Explicit void wording comes from the parsed cause, so a username such as `Void`
cannot create void credit. Missing lethal HP on non-void deaths remains uncounted;
the last known health alone does not prove the amount or cause of a final hit.

`tracking.damage` records the rule version, availability and totals;
`tracking.damageEvents` preserves attribution and void-finish evidence. Invalid,
partial or undecodable playback does not publish damage totals. The offline
damage trials remain available for algorithm comparison.

To backfill saved games using newly scored complete captures, first validate:

```
node scripts/backfill-player-damage.js --database data/replays.sqlite captures/damage-release-20260926/G00202.json
```

Add `--apply --backup <new-file.json>` to apply all validated inputs atomically.
The tool checks replay identity, duration, roster, teams and reciprocal totals.
It saves the original rows and changes only damage fields and evidence. Existing
scores, winner/name edits, resource totals, game IDs and timestamps are preserved.
Version 1 scores remain readable. A complete saved capture can be rescored and
backfilled to version 2; upgrading code does not rewrite earlier scores.
The #recent publisher refreshes existing cards after damage backfills or other score changes. Other previously posted Discord attachments remain snapshots. Damage displays round to whole HP; stored values and aggregation retain full precision.
