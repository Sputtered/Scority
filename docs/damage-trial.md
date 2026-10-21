# Experimental damage reports

Normal game cards include released player damage. `scripts/damage-trial.js`
compares attribution variants on a complete packet capture under 20 minutes and
writes a JSON evidence report and damage-only text without changing saved games.

```
node scripts/damage-trial.js captures/<capture>/packets.jsonl.gz --game G00202
```

Three selectors compare attributed damage coverage: `strict` (3.6 blocks with
swing, hurt and aim), `latency` (4.5 blocks with the same signals), and `isolated`
(also allow one nearby opposing player with hurt and aim when no swing is matched).
Yaw and pitch define an eye ray intersecting an expanded player box. The extra
range and geometry padding are experimental tolerances, not measured ping.
Signals must match entity generation and replay epoch and fall within
600 replay-scaled arrival milliseconds and one HUD sampling interval. Version 2
attribution ranks matches by arrival time and uses packet order to break ties;
unrelated packet count does not affect eligibility. Each loss needs exactly one
matched hurt; several hurt signals sharing one health update remain ambiguous. Each
swing can support only one attributed health drop. Same-team players cannot
receive credit. Unknown nearby teams, ambiguous attackers and burning victims
block attribution. These checks do not rule out all environmental or projectile
damage, occluded players, walls or missing packet evidence.
Range and aim use the victim/roster at the hurt and the attacker at the swing,
with recorded positions in each candidate's evidence. This preserves geometry
when knockback arrives before the corresponding health metadata.

In the `damage-v2` report format (`attributionVersion: 2`), dealt and received damage count only health loss attributed to
another player, in HP. Each player's received total equals their per-opponent
received damage; game-wide dealt equals received. The JSON diagnostic fields
`observedHealthLoss` and `unassignedHealthLoss` retain raw losses separately.
Observed health loss equals received plus unassigned health loss. Coverage still
uses all observed health loss as its denominator. Unassigned loss can include
fall/void damage and missed player hits; it is not labeled environmental.
Absorption, missing lethal updates, health loss mixed with healing, and unseen
players can make totals incomplete. Every observed player gets a row, including
zero totals. Independent labels are required to measure accuracy.

Discord embeds and text attachments display player damage only. Regenerate older
reports from their saved packet captures before posting. Update existing reports
in place, with the same capture hash and attachment name, using:

```
node --env-file-if-exists=.env scripts/post-damage-trial.js --update-existing <channel> <report.json> [...]
```

Update mode requires an existing report for every file and never creates new
messages. Unassigned loss and variant coverage remain in JSON evidence reports.

Reports retain packet sequences, candidate players, positions' distances, yaw,
pitch, matched hurt/swing sequences, methods and reasons for abstention. Partial
captures, navigation, world changes during playback, missing final HUD and durations
of 20 minutes or longer are rejected. Undecodable playback packets are reported.

The initial real-capture comparison uses one replay at two protocol/speed settings;
it is a repeatability check, not independent validation. Synthetic regression tests
cover geometry, wider range, missing swings, crowds, team ambiguity, fire,
healing/death/respawn baselines, shared swings, totals and capture guards.
