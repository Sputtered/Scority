# Voided diamonds

`diamondsVoided` counts diamond stacks inferred to have been released by a
player, observed moving below the recorded world's build floor, and then
removed without a collection packet. It measures observed physical throws.
A player dying while carrying diamonds does not qualify.

This is a conservative estimate. Replay packets do not identify an item's
thrower or give a reason for its removal. Ownership uses the existing unique
nearby-player release heuristic. Unknown owners and ambiguous quantities are
left unresolved. A numeric zero means no qualifying throw was observed, not
proof that the player never voided diamonds outside the spectator's visibility.

## Evidence and quantities

- A generation identifier distinguishes reused entity IDs.
- The tracker retains item movement, stack-count changes, collections and the
  position at removal. Disappearance above the world floor does not count.
  Collection evidence is retained even when item metadata arrives afterward.
- Generator spawns and classified death drops are excluded. Initial sightings
  already below the floor and items still visible at replay completion do not
  establish a complete falling trajectory.
- Quantities come from the physical item stack, independently of the resource
  ledger. `throw.quantity` is capped by the uncredited carried balance, so it
  cannot be used for this statistic.
- Stack growth requires a unique quantity-matching set of nearby disappearing
  stacks. All contributing stacks must have the same inferred owner. Conflicting
  ownership, unexplained growth or decreases, and donors that could explain
  multiple recipients leave the final quantity unresolved.
- A first metadata sample can already include a merge. Nearby earlier donors
  whose combined quantity is smaller than that first sample are included in
  its provenance, with the same ownership and ambiguity checks. The terminal
  surviving stack is counted once.
- Initial-metadata merge chains retain the intermediate stack's ancestry. A
  three-item survivor formed from successive one-item releases must not count
  both a two-item intermediate stack and the earlier item already inside it.
  Only intermediates small enough to fit the survivor can absorb candidates;
  competing recipients and mixed ownership remain unresolved.
  A single removal packet can contain both an original donor and an intermediate
  stack. Their ordered stack-count samples still establish the merge chain.

The merge window is at most one HUD resolution step and 128 packet positions;
candidate stacks must be within two blocks. These are conservative matching
limits, not measured accuracy guarantees. The world floor is the decoded
dimension's `minY`, rather than a fixed Y=0 for every protocol/map.

The existing resource accounting also no longer treats arbitrary repeated
spawn coordinates as a generator. Repeated stationary player throws now each
subtract their observed release quantity. Grid-centered resource spawns retain
the existing generator heuristic. The carried ledger shares the reconciled
initial release amount, so a merged stack's first metadata does not subtract
its already-counted donors again. When that original quantity is ambiguous,
credited totals for the affected resource stay unavailable and
`tracking.unresolvedResourceAmounts` identifies the resource.

## Availability and output

The value is available only after a valid replay finishes, with observed
players and no undecodable packets during playback. Incomplete, rewound,
world-switched or corrupt recordings return `null`. A participant known only
through chat without any observed player entity also remains `null`. A complete
valid replay without resource spawns can return zero for observed players. Historical games without the new
tracking version stay unavailable until rescored from a suitable capture.

`tracking.resourceVersion` is 2. `tracking.voidedDiamonds` has:

- `version: 1`
- `status`: `tracked`, `incomplete`, `invalid` or `unavailable`
- `rule`: the metric definition
- `unresolvedEvents`: observed falling diamond stacks with unresolved ownership
  or quantities
- `unresolvedCollections`: collection packets without an observed item identity

`tracking.resourceEvents` contains `kind: "void"` entries with player, quantity,
inferred attribution, throw time, removal time/sequence, entity generation,
source generations, final position and world floor. `void_unresolved` entries
preserve falling evidence without adding a player's statistic.
Throw events retain `groundCount` and add `physicalQuantity`; the latter removes
already-counted merge donors before the carried-balance cap is applied. An
ambiguous original release emits `throw_unresolved` instead of a guessed amount.

## Validation

`test/voided-diamonds.test.js` covers independent physical quantities, repeated
stationary throws, same-owner and mixed-owner merges, initial merged metadata,
merge chains, ambiguous merge recipients, pickups, generators, death drops,
carried-only deaths, despawns, unresolved owners, entity-ID reuse, world floors,
1x/4x playback, incomplete/corrupt recordings and rewinds.

The local raw 1.8.9 captures were also rescored:

| Capture | Observed inferred result |
| --- | --- |
| Reference replay `3dd626bb-1f78-4ef8-948a-7b820ca8114a` | Malthos 2, hesuki 7, Sputtered 1; two falling stacks remain unattributed |
| G00200 | BlockSpider98 3; the merged final stack is counted once |
| G00202 | spqrit 2, BlockSpider98 2, SYTUR0 2, NetherackPietro 4 |

These are packet-based checks against the reviewed trajectories. Independent
visual labels are still needed to measure precision and missed-event rates.
