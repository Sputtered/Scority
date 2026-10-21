# Bot review — September 26, 2026

## Summary

Damage attribution can be improved substantially. Five defects were reproduced: two in damage scoring, one in resource ownership, and two in the recently added connection/control code. Tracking diamonds thrown into the void is feasible from saved packet captures, but it requires tracking item movement and stack merges through to the outcome.

This was a review. Application source, deployed services, settings, scores, and the queue were not changed. Diagnostic scripts were added under `.work`.

## Confirmed findings

### 1. Damage matching depends on unrelated packet traffic — P2

**Location:** [lib/damage-experiment.js](../lib/damage-experiment.js), lines 62–64 and 77–79.

Hurt animations are paired with health losses by distance in the overall packet sequence. Two nearby hits can both attach to the same health change when unrelated packets arrive between the second hurt and its health update. One health loss is then rejected for having multiple hurt events, and the other for having none. Swing selection uses the same fragile ordering.

**Reproduction:** two 4 HP hits score 8 HP. Adding three unrelated keep-alive packets before the second health update makes the same hits score 0 HP. In five real captures, 54 unassigned health updates had a closer-in-time hurt signal that was paired elsewhere. Those real cases still need encounter review before deciding their correct attribution.

**Recommended fix:** match evidence within each player's life using replay-adjusted timing, causal order, and one-to-one hit matching. Keep ambiguous hits unassigned. Add regression coverage showing that unrelated traffic cannot change the result.

Diagnostic: [.work/review-damage-repro.mjs](../.work/review-damage-repro.mjs).

### 2. Repeated drops from one spot are mistaken for generator spawns — P2

**Location:** [lib/replay-stats.js](../lib/replay-stats.js), line 134.

Any location that produces two resource spawns is classified as a generator before player ownership is considered. This also describes a stationary player dropping items twice.

**Reproduction:** Alice picks up 5 diamonds, throws 2 twice from the same spot, then approaches an ender chest. The scorer records no throws and credits 5 diamonds; under the current crediting rule, it should credit 1. This affects resource totals and would also hide future void throws.

**Recommended fix:** identify generators using supported location/resource evidence and distinguish player releases. Repetition alone should not override a release attributed to a player. None of the four inspected raw resource captures showed this repeated non-grid spawn pattern, so existing games have not been proven affected by this particular defect.

Diagnostic: [.work/review-resource-check.mjs](../.work/review-resource-check.mjs).

### 3. Dashboard commands can wait behind Discord requests — P2

**Locations:** [app.js](../app.js), line 30; [lib/discord/control.js](../lib/discord/control.js), line 50; [lib/discord/notifications.js](../lib/discord/notifications.js), line 103.

Settings application, dashboard commands, and recorder checks share an awaited loop. Disabling a Discord worker can wait for its in-flight send. During that wait, dashboard commands and recorder checks stop progressing, while the independent heartbeat continues reporting the bot as available. Replay timeout recovery also waits through lobby/next-replay transitions in this loop. Long waits can outlast the 30-second command expiry.

**Reproduction:** hold a notification send pending, stop its worker, and submit Disconnect. The command remains pending with `available: true` until the send resolves.

**Recommended fix:** keep command processing and recorder watchdogs independent of Discord worker shutdown and long replay transitions. Track command-processor health separately from connection liveness.

### 4. Login failures can leak a recurring timer — P2

**Locations:** [proxy.js](../proxy.js), line 364; [lib/headless-viewer.js](../lib/headless-viewer.js), lines 25–26.

The proxy discards the cleanup function returned by the headless viewer. Its 50 ms timer normally clears on the Minecraft client's `end` event. An authentication failure before a TCP socket exists can bypass that event.

**Reproduction:** using the installed Minecraft client, a timer remains after a simulated authentication failure and after the connection manager stops. Repeated failures accumulate timers and can prevent graceful process exit.

**Recommended fix:** retain the cleanup function and call it unconditionally during session finalization. Also account for authentication work completing after a connection attempt has been abandoned.

Diagnostics for findings 3–4: [.work/review-reliability.mjs](../.work/review-reliability.mjs). Both findings are in the recent connection/control update.

### 5. A username can falsely trigger void damage — P3

**Location:** [lib/player-damage.js](../lib/player-damage.js), line 57.

Void detection searches the full death message, including player names. At Y=64, `Victim was killed by Void.` produces 20 HP of credited void finish damage when the victim's last known health is 20. The same event with a killer named `Attacker` produces none.

**Recommended fix:** inspect the structured death cause or parsed death wording with player names excluded. The damage diagnostic above includes this reproduction.

## Damage quality and next improvements

The latest 12 saved games examined, G214–G225, contained:

| Measure | HP |
| --- | ---: |
| Observed health loss, excluding added void finishes | 33,111.79 |
| Observed health loss assigned to a player | 18,994.10 |
| Observed health loss left unassigned | 14,117.69 |
| Additional remaining HP credited for void finishes | 5,287.58 |

The scorer attributed **57.4% of observed health loss**. This measures coverage, not accuracy: environmental damage belongs among unassigned losses, and some assigned hits could still be wrong. Added void finishes must be kept separate when measuring coverage.

After fixing matching, the most useful improvements are:

1. Use player positions around the hurt/swing, because the later health update may show positions after knockback.
2. Investigate conservative recovery of missing lethal damage. Five older captures contain 216 server-credited non-void deaths with positive last-known health. Their remaining 653.12 HP is a set of candidates to review, not an amount safe to add automatically. Freshness, intervening damage, death cause, and duplicate credit all matter.
3. Evaluate projectile ownership, fire/explosion attribution, absorption, healing, and crowded fights against independently reviewed encounters before expanding attribution rules.
4. Expose direct attributed damage and credited void finishes separately in diagnostics, with unassigned reasons and a scoring version for later backfills.

## Diamonds voided

### What is possible now

The current scorer identifies inferred throws at spawn, but does not follow their outcomes. Entity destruction currently removes the entity without classifying why it disappeared: [lib/capture-analysis.js](../lib/capture-analysis.js), line 216.

Saved captures do contain useful trajectories. In the complete legacy reference capture, eight attributed diamond item trajectories fell below Y=0 and disappeared without pickup; their stacks total 10 diamonds. Two more trajectories totaling 3 diamonds had unresolved ownership. For example, Malthos's two-diamond item appears at 03:18 and disappears at 03:23 after reaching Y=-4.84375. These are inferred candidates; the captures alone do not establish intention.

### Recommended scoring rule

Count diamonds physically released by an identified player that are observed descending beyond a verified void boundary without being collected. Keep ambiguous ownership and incomplete outcomes unresolved. Falling off while carrying diamonds is a separate event from throwing diamonds into the void.

The implementation needs to preserve each item generation's spawn, stack changes, movement, collection, and disappearance. Exclude generator spawns, death drops, ordinary despawns, replay resets, and visibility loss. Disappearance alone is insufficient evidence.

Stack merges require explicit quantity and ownership bookkeeping. In G00202 at 05:58, one diamond entity grows from 1 to 2, falls to Y=-8.4375, and disappears; another disappears above ground during the merge. Count the final voided quantity once. For merges involving different throwers, unresolved provenance should stay unresolved.

### Existing throw quantities cannot be reused directly

At [lib/replay-stats.js](../lib/replay-stats.js), line 153, `throw.quantity` is capped by the player's **uncredited carried balance**. Approaching an ender chest clears that balance under the existing scoring rule; it does not prove a deposit, and withdrawals are unobserved.

G00200 contains a real throw with `quantity=0` and `groundCount=1`, later merged and collected by a teammate. G00199 contains a throw with `quantity=1` and `groundCount=2`. Using `throw.quantity` would undercount physical throws. Summing all spawn quantities is also unsafe because the first visible metadata can already include a merge.

Record each void event's thrower, time, quantity, source generations, and evidence status. Expose `diamondsVoided` through shared stat fields, aggregation, website, Discord, and cards. Historical captures without enough evidence should show unavailable rather than a false zero.

Validation should cover single-item and whole-stack throws, repeated stationary drops, passes, pickups, same/different-owner merges, death drops, ambiguous owners, entity reuse, visibility loss, 1×/4× playback, and incomplete/rewound recordings. Review real encounters independently before claiming measured accuracy.

## Runtime and validation

- The bot and website services were active at inspection; Minecraft was online, the queue was clear, and the heartbeat was current.
- A recent interrupted job, R218, completed after one reconnect retry.
- R217 failed after the replay HUD did not load for 120 seconds. A bounded retry could help transient load failures, but this record alone does not establish whether the replay was valid or accessible.
- Reconnect deduplication, persistent manual disconnect, and dashboard authentication/CSRF handling looked sound in the reviewed paths.
- The full current suite passed: **243 tests, 0 failures**. The additional diagnostics reproduced the defects above, which existing tests do not cover.

Recommended order: fix damage matching and resource classification, resolve the two control/reconnect defects, then add diamonds voided with merge tracking and reviewed examples. Recalculate historical scores only after the updated scorer has been validated.
