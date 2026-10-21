# Diamonds and emeralds - Inventory release history

Current production scoring also includes [player damage](player-damage.md),
with PvP-only received totals and credited void finishes. The resource release
and the older prototype below are retained as historical evidence; their damage
definitions do not describe the current release.

Inventory is the default card design, using Minecraft 1.8.9 block, item and font
textures. Game and profile cards have no accounting explanation footer. Historical
missing resource values remain unavailable rather than becoming zero.

The recorder requests 4x through the observed HUD, increasing/decreasing speed
one step at a time and resuming after reaching the target. Packet order remains
the source of accounting order; HUD matching and buffering allow accelerated
samples. Rewinds and large seeks invalidate resource totals. A full local live
1.8.9 capture at 4x completed the full 537-second replay. Its credited diamond
and emerald totals match the modern 1x capture for all eight players (16/16
values), with 85 identified resource pickups in each capture and no playing
packet decode errors. Legacy scoreboard suffixes, chunk unloads, and batched
relative movement are covered by regressions. All 141 automated tests pass.
This single-replay comparison is a compatibility check, not a measured general
accuracy percentage for inferred releases.

The resource model uses ground-stack metadata quantities, credits at ender-chest
proximity, subtracts inferred partial throws, and transfers uncredited balances
using the existing kill parser. Release ownership is inferred and ambiguous
spawns remain unresolved; this is not full inventory reconstruction.

Developer commands:

```sh
npm test
node test/dry-run.js
npm run capture:replay -- --replay REPLAY_ID --username Sputtered --version 1.8.9 --auth-dir ./mc-auth-cache --speed 4 --spectator-movement
npm run score:capture -- path/to/packets.jsonl.gz
npm run preview:scored -- path/to/scored.json
```

The following report is retained as the earlier prototype evaluation, preceding
the user's decision to remove damage statistics.

---

# Extended replay statistics

Implemented locally on 2026-09-24. The recorder, JSON exports, SQLite game
payloads, aggregate profiles, comparisons, and all three image-card styles now
include four additional per-player fields. Existing kills, deaths, finals, beds,
and winner scoring continue to use the existing chat parser.

| Field | Meaning |
| --- | --- |
| `damageReceived` | Sum of observed health decreases, in HP (2 HP = one heart). |
| `damageDealt` | Prototype attribution of other players' observed health decreases. |
| `diamondsCollected` | Diamonds credited under the requested ender-chest proximity rule. |
| `emeraldsCollected` | Emeralds credited under the same rule. |

## Resource accounting

The last observed **ground-item metadata stack quantity** adds to a player's
carried balance when that entity is collected. Held items and collection-animation
quantities do not determine the amount. Raw pickups remain available in
`resourcePickups` for inspection.

Coming within an inclusive 5-block 3D distance of an ender-chest block's center
credits the carried balance and clears it. A new pickup while already within
range is credited once as well. This is proximity credit, not a verified deposit.
Iron and gold are ignored.

The existing kill parser transfers only the victim's uncredited carried balance
to a known killer. Unknown killers clear the balance and log an unresolved loss.
Previously credited totals stay with their original player. Resource operations
wait two replay seconds so nearby death chat can classify a death drop before
the collection event would add the same resources again.

Throws are inferred from a new resource item appearing at one uniquely nearby
player's body height. Grid-centered/repeated generator spawns and nearby death
drops are checked first. An inferred throw subtracts only its initial ground
quantity, capped by the tracked balance; later stack merges do not subtract it
again. Ambiguous ownership stays unresolved and is reported in `tracking.issues`.
The replay does not expose a confirmed thrower packet. These heuristics can
misclassify unusual spawns, merges, or overlapping deaths. Purchases, withdrawals,
and unobserved inventory changes are outside this model.

## Health and damage attribution

Fractional health decreases accumulate separately from healing. New entities,
death chat, and replay epochs reset health comparisons. Damage received is
**observed health loss**, including environmental loss: missing final health
updates, absorption, or damage and healing combined into one update can leave
gaps. It is not a reconstruction of every original server damage calculation.

The `melee-v1` prototype requires a matching hurt event, an arm swing, range,
facing direction, and exactly one plausible attacker. Same-team swings and
ambiguous fights are rejected. Events match within one HUD second and 180 packet
positions; distance is at most 3.75 blocks. A tight match scores heuristic
confidence 0.85; a wider match scores 0.65. If a modern damage event supplies a
resolvable player source, it can provide direct attribution (confidence 1).
No direct-source events were present in this real capture. Unsupported projectile
and environmental hits remain unassigned unless a direct source is available.

**Confidence is evidence strength, not measured accuracy.** Player confidence
is weighted by attributed HP. Coverage is the fraction of observed HP loss
assigned to any attacker. Accuracy stays `null` and the UI says “unmeasured”
until independent labels exist. Neither synthetic test success nor coverage is
presented as live accuracy.

## Scored local replay

The existing full, uninterrupted 1x capture of replay
`3dd626bb-1f78-4ef8-948a-7b820ca8114a` was rescored without reconnecting to Hypixel.

- 8 players; 08:57 duration; green wins.
- 387 observed health-loss events totaling **1,222.6928 HP**.
- **796.4164 HP attributed: 65.1% coverage** (236 of 387 health-loss events
  assigned). Accuracy remains unmeasured.
- 4 ender chests decoded; no chunk or packet-decoding errors during playback.
- 85 identified diamond/emerald collection events. The two known emerald
  metadata/animation disagreements use the ground quantity of 2.
- 1,879 collection events had no visible item-stack identity. Earlier analysis
  places them beyond 64 horizontal blocks from the viewer; their resource types
  cannot be proved from these packets. They are not invented or counted.
- Some resource release ownership remains unresolved. The replay has no
  independently labeled partial-stack throw; controlled tests exercise the
  requested accounting rules, without establishing live resource accuracy.

For Sputtered this produces 195.616 HP received, 118.6408 estimated HP dealt,
6 diamonds credited, and 2 emeralds credited. The emeralds reach Sputtered through
kill transfer, which uses the full existing color-aware chat parser. That parser
recognizes 66 deaths; the earlier plain-text evidence inventory recognized 65.

Artifacts (local, ignored by source control):

- [Scored replay and per-event evidence](../captures/2026-09-24T20-54-47-148Z-1.21.11/scored.json)
- [Player card](../captures/2026-09-24T20-54-47-148Z-1.21.11/cards/studio-player.png)
- [Game card](../captures/2026-09-24T20-54-47-148Z-1.21.11/cards/studio-game.png)

## Running and evaluating

The production proxy remains on Minecraft 1.8.9. Its local socket integration
test sends encoded player, health, item, collection, and chunk packets through
the actual recorder into SQLite, then checks the resulting stats. Live 1.8 chunk
buffers, bulk chunks, partial section updates, and 1.21.11 chunks are supported.
`config.js` defaults to no replay-control clicks, preserving default 1x playback.
If the server retains another speed, return to the beginning at 1x before capture.
Seeking, starting late, or changing worlds during playback invalidates extended
totals rather than accumulating duplicate counts.

On Windows use `npm.cmd` if PowerShell blocks `npm.ps1`:

```sh
npm test
node test/dry-run.js
npm run score:capture -- captures/2026-09-24T20-54-47-148Z-1.21.11/packets.jsonl.gz
npm run preview:scored -- captures/2026-09-24T20-54-47-148Z-1.21.11/scored.json
```

Scoring requires a closed capture that reaches the finished HUD. These commands
only create local JSON/PNG files; they do not import a game into the Discord
library or connect an account. The six scored previews use placeholder avatars.

To measure attribution accuracy, independently review a representative set of
hits (including crowded fights, projectiles, and environmental damage), then
create a labels JSON array. Use the actual `sequence` numbers from
`tracking.damageEvents`; the following numbers and names are only examples:

```json
[
  { "sequence": 12345, "attacker": "KnownAttacker" },
  { "sequence": 23456, "attacker": null }
]
```

`null` labels verified non-player damage. Omit events whose cause cannot be
independently established. Do not copy the model's prediction into the label.

```sh
npm run evaluate:damage -- path/to/scored.json path/to/labels.json
```

The report gives correct/incorrect assigned events, abstentions, accuracy among
assigned labeled events, and labeled-event coverage. This event-based evaluation
coverage differs from the HP-weighted replay coverage shown on the game card.
An abstention is not treated as a claim that damage was environmental. Without
assigned labeled events, accuracy remains null.

Old game payloads need no database migration. Missing/invalid new stats display
as an em dash and are excluded from the corresponding aggregate; measured zero
remains zero. Profiles show how many games have health/resource data. Name links
apply to the new per-event evidence as well as the scoreboard. The legacy chat
scoring dry run and 139 automated tests pass, including accounting, attribution,
storage, UI, image rendering, cache refresh, and actual local recorder transport.
