# Estimated team upgrade times

New recordings include `teamUpgrades` in the scored JSON. Game cards in all four
styles and the text scoreboard show Sharpness, P1, P2, P3 and P4 for each team.
The heading is **Est. acquired by**. Missing or conflicting evidence displays a
dash, including older games without packet evidence. There is no explanation
footer on the Inventory card.

The saved test replay contained no upgrade-purchase chat messages. Enchantment
metadata remains unsuitable for reading the real upgrade level. The timeline
therefore uses the existing isolated-sword-hit selector and the vanilla 1.8
damage hypothesis; see [the Protection experiment](protection-estimator.md) for
the model and its source references. It does not restore damage statistics.

## Meaning of a time

For each selected hit, enumerate every compatible combination of defender
Protection 0–IV, attacker Sharpness 0/I, and allowed critical states. Project
these possibilities onto the defender's team for Protection and the attacker's
team for Sharpness. Ambiguous I/II evidence can support P1 but cannot establish
P2. Displayed enchantments and glints do not establish a level.

An upgrade needs two separate selected hits requiring at least that level,
within 120 replay seconds and one observation epoch. Team evidence can come
from different players. This is an exploratory corroboration threshold, not
the ten-hit player-level validation threshold or a calibrated confidence score.
The model assumes team upgrades apply uniformly to equipped armor and swords.

- `bySec`: the first supporting HUD timestamp plus its playback resolution,
  bounded by total replay duration. The upgrade is estimated to exist by this
  point; its purchase can be substantially earlier.
- `afterSec`: the last preceding hit that only permits a lower level, when
  available. Together these give an estimated acquisition interval.
- `evidence`: packet sequence numbers of the supporting hits. `priorEvidence`
  points to the preceding lower-level observation.
- A later hit requiring a lower level conflicts with a corroborated permanent
  upgrade. That entry is withheld as `conflicting`.

Unexplained hits stay counted in `unexplainedHits`. Missing evidence is not
evidence an upgrade was never bought. If a higher level is first observed, lower
levels may share its acquired-by bound; their exact individual times are not
invented. Interrupted or invalid timelines do not publish estimates. Rewinds,
large seeks and late starts use the recorder's existing invalidation checks.

Attacker attribution, effect completeness, and Hypixel's exact damage formula
remain unverified. `accuracy` is null. Team upgrade events store sequence numbers
instead of player names, so name corrections do not change team timing.

## Saved replay comparison

Both captures are replay `3dd626bb-1f78-4ef8-948a-7b820ca8114a`.

| Team / upgrade | 1x modern: estimated acquired by | 4x legacy: estimated acquired by |
| --- | --- | --- |
| Green Sharpness | 2:21 | 2:27 |
| Green P1 | 6:09 | 6:12 |
| Green P2 | 7:10 | 7:47 |
| Red Sharpness | 4:31 | 4:43 |
| Red P1 | 6:36 | 6:52 |
| Either team P3 / P4 | Unobserved | Unobserved |

The selected hits were 73 at 1x and 35 at 4x. The same upgrades have supporting
evidence in both captures, but the bounds differ because earlier qualifying hits
are sometimes absent. This comparison changes both speed and protocol; it is
not an accuracy measurement or evidence that timing is identical at 4x.

Regenerate locally without submitting or changing stored games:

```powershell
node scripts/score-capture.js captures/<folder>/packets.jsonl.gz captures/upgraded-game.json
node scripts/preview-scored.js captures/upgraded-game.json previews/upgrades
```

The live recorder forwards receive timestamps into the same selector. Offline
scoring preserves captured receive timestamps rather than analysis execution
time. Result JSON and the card cache include the timeline.

## Public access and queue priority

All valid Discord accounts may use the public commands. Owner-only controls
still check owner `the configured DISCORD_OWNER_ID` on every request, including buttons.
The old whitelist commands are retired; historical whitelist data does not
grant, remove or change access or queue priority.

- `/priority user:<person>` grants priority.
- `/priority user:<person> enabled:false` removes priority.
- `/priority` lists priority users.

Priority is persisted in SQLite and immediately changes waiting positions.
The current recording stays first; priority waiting jobs come next, then
standard jobs. Both groups use FIFO order. Everyone, including owner and
priority users, has five accepted submissions per Pacific calendar day across
all servers and DMs. Priority never changes quota. Existing daily usage is
preserved on upgrade. The existing owner-only `/resetlimit` remains an explicit
manual reset, and retries do not charge a second submission.

Deployment requires updating source, running tests, registering the revised
36 global commands, and restarting the service between recordings. Registration
alone does not update runtime behavior. Existing game payloads are not backfilled
because they lack the needed combat evidence.
