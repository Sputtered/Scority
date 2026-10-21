# Offline Protection experiment

The prototype estimates which Protection levels could explain isolated sword
hits in saved replay packets. Its ten-hit player estimates remain a local
diagnostic. The same combat selector and damage model now also support the
separate [estimated team upgrade timeline](team-upgrades.md) on new game cards.

## Run

```powershell
npm.cmd run estimate:protection -- captures/<folder>/packets.jsonl.gz
```

Pass both captures to compare repeatability, and optionally select the starting
time of the ten-event review table:

```powershell
npm.cmd run estimate:protection -- captures/2026-09-24T20-54-47-148Z-1.21.11/packets.jsonl.gz captures/2026-09-25T00-22-14-969Z-1.8.9/packets.jsonl.gz --review-from 420
```

Inputs must finish with the `Replay finished` marker. Each capture receives a
`protection-experiment.json` containing selected and excluded health drops,
packet sequence numbers, evidence, and every tested model fit. The combined
readable report and comparison JSON go to `captures/protection-estimate/`;
`--report-dir` changes that directory. Capture hashes identify the tested inputs.

## Findings from the supplied replay

Replay: `3dd626bb-1f78-4ef8-948a-7b820ca8114a`. These observations use the vanilla
1.8 hypothesis described below; the actual server implementation is unverified.

| Capture | Health drops | Selected hits | Hits compatible with at least one Protection level | Complete ten-hit windows |
| --- | ---: | ---: | ---: | ---: |
| 1.21.11 at 1x | 387 | 73 | 72 | 0 |
| 1.8.9 at 4x | 368 | 35 | 34 | 0 |

These counts measure model fit, not accuracy. There are no confirmed Protection
labels. The captures also differ in protocol, so differences cannot be attributed
to replay speed alone. All 32 uniquely matched selected events had identical
candidate sets across the two captures; these are repeated observations of the
same events, not independent samples.

Promising provisional candidates in the 1x capture:

| Defender | Time | Evidence | Compatible level over those hits |
| --- | --- | --- | --- |
| BackCracked | 7:43–7:44 | Two hits losing 2.9232 and 3.2480 HP | II |
| LilDay | 7:09–7:51 | Four selected hits | II, if the level stayed constant |
| qMoza | 6:35–8:06 | Six selected hits in one armor appearance segment | I |
| Snoudy | 6:52–8:05 | Five selected hits in one armor appearance segment | I |

BackCracked's second hit is packet `146268`: the only tested compatible level
is II. The first hit alone permits II or III. The first hit also survives the
4x filters, but the second does not; the specific II conclusion is therefore
not independently reproduced by the 4x capture. An earlier hit at 6:22 permits
I, which could indicate a later upgrade or an incorrect inference. It must not
be combined with the later hits as if Protection were constant throughout.

One selected Sputtered event at 6:51 loses 1.68 HP and fits neither model. It
remains in the output as unexplained damage. It was not dropped to improve the
fit rate.

No player has ten selected hits within a 120-second window in one unchanged
armor appearance segment. Consequently the prototype emits **no formal player
level estimate** for this replay. The table above lists exploratory candidates.
The report's ten-event review table involves several players and is not a
ten-hit validation of any one player's level.

## Selection and models

A candidate hit requires a nonfatal health drop matched to one hurt event,
known armor and player flags, zero observed absorption before and after, one
nearby opposing player holding a sword, a matching swing, and suitable facing.
Observed blocking, fire, relevant potion effects, nearby health changes, or
equipment changes exclude a hit. Selection does not inspect model fit.

The attacker is inferred rather than supplied by a direct attacker-ID packet.
Swing and hurt matching use packet order, HUD time, and receive-time proximity
scaled by playback speed. Arrival timing can be distorted by network batching.
The default proximity limits are 100 packets, 350 scaled milliseconds, and
3.6 blocks. Critical animations are matched to their victim near the hurt event;
their absence leaves both normal and critical damage possible.

Both models enumerate Protection 0–IV, Sharpness 0/I, and the allowed critical
states. A level is assumed uniform across equipped armor pieces. Displayed
enchantment levels are not trusted. The acceptance tolerance is 0.002 HP for
floating-point variation; this is not a confidence interval.

- `vanilla-1.8`: sword base damage (including the player's base attack), critical
  multiplier on base damage, Sharpness bonus, armor reduction, then randomized
  enchantment protection. All permitted random outcomes are enumerated.
- `linear-4pct`: an alternative hypothesis with four percentage points of
  reduction per Protection level per worn piece, capped at 80%.

The first model fits more selected events in these captures, but neither model
is verified as Hypixel's implementation. Protection levels can overlap in their
possible damage outcomes. A unique compatible level after at least ten hits
produces `conditional-estimate`; multiple levels produce `ambiguous`, and no
compatible level produces `model-mismatch`. Fewer than ten hits always leaves
`estimatedLevel` null. The ten-hit threshold is an experiment rule, not a
statistically calibrated guarantee.

Armor appearance changes split the formal windows. Invisible Protection
upgrades can still happen within a window; whole-segment fits are explicitly
diagnostic. Effect, absorption, animation, and equipment metadata completeness
is not independently established. Ground-truth accuracy remains null until
known-level examples and separate validation hits are available.

## Reference implementation

These sources describe the modeled 1.8 behavior, not proof of Hypixel's rules:

- [Protection factor per armor piece](https://github.com/Attano/Spigot-1.8/blob/master/net/minecraft/server/v1_8_R3/EnchantmentProtection.java)
- [Randomized protection factor and cap](https://github.com/Attano/Spigot-1.8/blob/master/net/minecraft/server/v1_8_R3/EnchantmentManager.java)
- [Critical hits and enchantment damage](https://github.com/Attano/Spigot-1.8/blob/master/net/minecraft/server/v1_8_R3/EntityHuman.java)
- [Damage modifiers and absorption](https://github.com/Attano/Spigot-1.8/blob/master/net/minecraft/server/v1_8_R3/EntityLiving.java)

The tests cover known synthetic levels, overlapping candidates, unexplained
damage, both packet versions, blocking transitions, missing equipment,
absorption, crowded fights, animation association, respawns, and window bounds.
Synthetic correctness establishes the implementation's behavior, not real
replay accuracy.
