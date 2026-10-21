# Local replay packet validation

Test date: 2026-09-24. Replay: `3dd626bb-1f78-4ef8-948a-7b820ca8114a`.
Viewer account: Sputtered. Windows, Node 24.21.0, minecraft-protocol 1.67.0,
minecraft-data 3.113.2, prismarine-chunk 1.41.0.

This is the original evidence-gathering report for the damage/resource tracker.
The subsequent implementation, scored replay, and accuracy evaluation workflow
are documented in [Extended replay statistics](extended-stats.md).
It does not produce verified damage-dealt or carried/credited resource totals.
The supplied replay has no independently labeled partial-stack throw or kill
while carrying resources, so those ground-truth tests remain open.

## Capture status

The Minecraft 1.21.11 capture **completed from 00:00 through 08:57 at 1x** in
`captures/2026-09-24T20-54-47-148Z-1.21.11/`, with no seeking. The final HUD
reported `finished 537/537 1x`, the client exited successfully, and its connection
closed. The viewer moved 0.1 blocks and returned every two minutes.

| Final capture measurement | Result |
| --- | ---: |
| Health samples / fractional samples | 933 / 711 |
| Health decreases / healing changes | 387 / 418 |
| Direct damage-event packets / hurt animations | 0 / 351 |
| Identified diamond/emerald collection events | 85 |
| Collection events with no observed item-stack identity | 1,879 of 2,069 |
| Resource quantity disagreements | 2 |
| Decoded ender chests / proximity entries | 4 / 166 |
| Parsed deaths | 65 |
| Undecodable frames during playback / chunk errors | 0 / 0 |

These are observations, not final player statistics. All 85 identified resource
collections carry `pickupItemCount: 1`; two have last observed emerald stack
metadata of 2, at 03:20 (Snoudy) and 08:33 (qMoza). All 1,879 collections lacking
an observed item stack occurred more than 64 blocks horizontally from the viewer.
Of 190 collections with a known item stack of any type, 175 were within 64 blocks.
This repeats the distance association described below; it does not prove its cause.

Local artifacts:

- [Analysis](../captures/2026-09-24T20-54-47-148Z-1.21.11/analysis.json)
- [Packet examples, controls, visibility measurements, and SHA-256](../captures/2026-09-24T20-54-47-148Z-1.21.11/evidence-examples.json)
- [Raw gzip JSONL](../captures/2026-09-24T20-54-47-148Z-1.21.11/packets.jsonl.gz)

The gzip fully decompresses to 169,928 records and is 5,297,218 bytes on disk.
The evidence file can be regenerated with `node captures/2026-09-24T20-54-47-148Z-1.21.11/extract-evidence.mjs`
after running the analyzer. Initial lobby decoding failures (4 inventory windows,
8 slot updates, 618 particle frames) are preserved as raw frames and excluded
from the zero-error playback count.

The earlier stationary capture in
`captures/2026-09-24T20-36-40-256Z-1.21.11/` reached 05:18 of 08:57 before
Hypixel kicked the viewer for inactivity. Its saved gzip is a complete file,
but the replay observation is partial. `captureEnded` and `replayFinished`
are separate analysis fields for this reason.

The next attempt, `captures/2026-09-24T20-43-43-430Z-1.21.11/`, reached 08:43
before Hypixel reported `Sending packets too fast!` and moved the viewer to the
lobby. It is also partial. The modern idle loop was then reduced from per-tick
movement packets to a once-per-second position reminder, while retaining client
tick delimiters and required server acknowledgments. This matches the stationary
movement scheduling in [Mineflayer's physics code](https://github.com/PrismarineJS/mineflayer/blob/master/lib/plugins/physics.js).
Legacy 1.8.9 retains per-tick movement updates. Rate-rejection messages now stop
the capture immediately with a failure status.

Hypixel explicitly rejected the attempted 1.19.4 connection. The early 1.8.9
smoke capture reached playback but stopped after an out-of-sync error; legacy
transaction acknowledgments were subsequently added, without a full legacy
retest. The live findings below concern 1.21.11.

## Findings

| Question | Observation | Consequence |
| --- | --- | --- |
| Health field and precision | Player `entity_metadata` key 9 carries floating-point health, including fractional values. | Health-loss and healing changes can be kept separately. They are observed deltas, not independently verified complete damage totals. |
| Separate hits | Multiple decreasing updates for one player occur within the same HUD second. | Preserve packet order; do not collapse all updates with one timestamp. |
| Direct attacker IDs | No `damage_event` packets observed in the full replay; 351 `hurt_animation` packets were observed. | The newer client has not supplied a direct attacker identity. Swings/positions remain evidence for future inference, not verified attribution. |
| Resource identity and collector | Some item metadata resolves diamonds/emeralds; `collect.collectorEntityId` resolves a player. Many collected entities have no observed item-stack metadata. | Keep unresolved collections explicitly. Visible resource pickups are not a completeness guarantee. |
| Pickup quantity | At 03:20, one emerald entity has last observed stack count 2 but `pickupItemCount` is 1, followed by entity destruction. | Neither field should be accepted as a validated quantity rule from this replay alone. |
| Throws | Observed resource spawn fields do not directly name a thrower. Nearby players can be listed. | Do not turn proximity into an asserted thrower, or subtract an invented amount. |
| Deaths and transfers | Chat identifies named killers and environmental deaths. | A death message does not establish the resource quantity transferred or deduplicate later collection packets. |
| Player name matching | The NPC profile `CharlieJohnson\u00a7r` uses a team suffix `\u00a7a8`, rendering `CharlieJohnson8`. | Resolve team prefix/profile/suffix together when the result is a valid username; otherwise death and entity records can disagree. |
| Ender-chest proximity | Chunk data yields four ender chests; entity movement supplies player positions. | The geometric five-block rule is measurable. Inventory crediting is not yet validated. |
| Playback timing | The baseline uses normal speed from the beginning. HUD time is whole seconds. | Packet arrival time is not an exact replay hit time; preserve the last HUD time plus sequence number. |

### Reproducible examples from the initial partial capture

References below are JSONL `sequence` values, not file line numbers. They refer
to the 20-36-40 capture, whose analysis and `evidence-examples.json` remain local.

- At 00:48, Malthos changes from 18 HP to 12.960000038146973 HP (sequence 17645),
  an observed loss of approximately 5.04 HP.
- At 00:49, CharlieJohnson8 decreases from 18 to 15.760000228881836 (17769),
  then to 13.800000190734863 (17813). Two distinct updates survive within one
  displayed replay second; this does not prove every original hit is separate.
- Emerald entity 2837 spawns at 01:49 (36913), changes to emerald count 1
  (36929), then count 2 (36981). At 03:20, Snoudy collects it with
  `pickupItemCount: 1` (63772); it is destroyed at 63804. The true inventory
  change is not independently labeled.
- The same partial analysis has 1,264 collection events, 1,166 without a
  matching observed item stack, and no unresolved collector names. A raw-file
  cross-check finds 1,164 collected IDs with no `spawn_entity` anywhere in that
  capture. Do not assume these unseen items are iron, gold, diamonds, or emeralds.

An additional position cross-check found that 1,165 of the 1,166 unresolved
collections occurred with the collector more than 64 blocks horizontally from
the viewer; 95 of 98 collections with an observed item stack were within 64
blocks. This is evidence of a distance association, consistent with spectator
entity visibility limiting item observations. A separate capture from another
viewpoint is needed to establish the cause and a reliable coverage strategy.

Potential item-release windows for visual review are 01:49 (emeralds appearing
near Sputtered), 02:47 and 03:10 (diamonds near Sputtered), and 03:18 (two diamonds
near Malthos). These are candidates, not verified throws or partial-stack events.
Generator spawns and death drops must be excluded before assigning ownership.

Ender-chest block coordinates from decoded chunk palettes:
`(-73,65,17)`, `(-17,65,-73)`, `(73,65,-17)`, `(17,65,73)`.
The implementation currently measures 3D Euclidean distance from the player's
position to the block center, inclusive at 5.0 blocks. This explicit convention
still needs to match the intended product rule. `block_action.blockId` showed
130 even under the modern registry, so the locations use chunk palettes rather
than interpreting that field as a modern block ID.

## Validation and limits

The local suite passes 122 tests. Four pre-existing tests needed Windows cleanup
ordering fixes: close the reopened SQLite database before removing its temporary
directory. The existing dry-run simulation also passed.

New tests cover fractional health loss versus healing, resets at death/spawn and
rewind, immutable pickup position snapshots, unresolved item identities, conflicting
quantity fields, binary/raw packet preservation, modern damage-event codec fields,
legacy versus modern collection schemas, NBT replay HUD parsing, decoded chest
locations, inclusive five-block boundaries, and repeated movement within range.
Team-suffix reconstruction is tested against death resets and non-name decorations.
They also distinguish a closed partial capture from a finished replay and preserve
replay chest locations after a later lobby transition.

Codec tests show what the installed protocol can encode/decode, not what Hypixel
actually sends. Modern lobby frames sometimes fail inventory/particle decoding;
the diagnostic client keeps each complete raw frame with its error and continues
at the next packet. Analysis separates decoding failures during playback from
those outside playback. An empty playback-error count cannot prove that the
server sent every event from the original match.

Health comparisons reset on spawn, death chat, world transition, or rewind.
No damage-dealt assignment is made. A death may lack a final zero-health update;
absorption and environmental causes need their own validation. The current
evidence tool counts proximity entries, not resource credit: a future ledger
must also check newly picked-up/transferred resources while already in range,
then clear carried balances once per credited quantity.

## Remaining controlled tests

Follow-up ground-item check: dropped-item entity metadata confirms all four resource
types, with observed stack sizes of 1/2 diamonds, 1/2/9 emeralds, 1 through 5 iron
ingots, and 1/2 gold ingots. These observations do not use player equipment or hand
contents. The requested quantity rule is now explicitly the latest observed ground
stack count; `collect.pickupItemCount` remains a diagnostic field. The two emerald
disagreements above were ground-stack metadata versus the collection packet, not
ground items versus held items. Full carried/credited accounting is still pending.

Four diamond piles are present simultaneously at 00:01, and recurring diamond
spawns occur at four locations: `(-33.5,67.5,49.5)`, `(-48.5,67.5,-33.5)`,
`(49.5,67.5,34.5)`, `(34.5,67.5,-48.5)`. Recurring emerald spawns occur at
`(0.5,66.5,0.5)` and `(0.5,76.5,0.5)`. These are spawn positions; ground items
can subsequently fall or move. See the [ground-item evidence](../captures/2026-09-24T20-54-47-148Z-1.21.11/ground-item-inventory.json).
Unresolved item types cannot be independently identified from missing metadata;
the explanation that distant base-generator drops are iron/gold is consistent
with the visibility evidence, but not proof that every unseen pickup is one of those types.

1. Label isolated melee, overlapping attackers, projectile hits, and environmental
   damage, then compare health/hurt/swing/position packets against those labels.
2. Repeat a short segment from a base viewpoint to test the distance-associated
   missing item identities. Then observe known single-item and multi-item pickups, including merging item
   stacks, to resolve the metadata-versus-collection quantity discrepancy.
3. Label a partial-stack diamond/emerald throw with known thrower and amount.
   Confirm whether usable ownership evidence exists beyond nearby players.
4. Label a kill with a known carried balance and examine subsequent collections
   to establish one transfer without double counting. Test an unknown killer too.
5. Verify the proposed carried-to-credited rule, including a new pickup while
   already near a chest; proximity alone is intentionally not an actual deposit.
6. Run a separate navigation experiment for live pause, speed changes, and seeks.
   Current rewind coverage is a local state-reset test, not a live deduplication
   guarantee. Keep the first usable baseline free of seeks.

Run instructions are in [README.md](../README.md#local-damageresource-packet-tests).
Raw captures and authentication caches stay in ignored local folders.
