# Rescoring saved games

Owner `the configured DISCORD_OWNER_ID` can run `/rescore replay:<reference>` or press
**Rescore game** on a finished-game panel. References accept `G00001`, `R00001`,
or the stored Hypixel replay ID. Imported games need a known replay ID; those
without one cannot be recorded again.

The operation queues a fresh Hypixel recording at the configured replay speed,
using the current scoring rules, including diamonds, emeralds, and estimated
team upgrade times. It does not reanalyze old scored JSON, which lacks the raw
packets needed for new metrics. Hypixel must still make the replay available.

## Saved-result guarantees

- The existing game stays visible and counted while rescoring waits or runs.
- Successful recording updates the existing game's payload and fingerprint in
  one SQLite transaction. It does not insert another game.
- The game ID and original `recorded_at` stay unchanged, preserving result links
  and game chronology. Current name corrections, global name links, owner winner
  overrides, and void status remain in effect.
- The old raw payload and fingerprint are archived in `game_revisions` together
  with the job, requesting owner, and replacement time. No revision is saved for
  an unsuccessful replacement.
- Empty, short, incomplete, wrong-replay, invalid-tracking, or duplicate-other-
  game results are rejected. A recording missing a player with a saved name
  correction is also rejected. Previous results survive failure or expiry.
- A queued rescore can be cancelled. The owner can retry a failed/cancelled
  attempt with `/retry`, or request another `/rescore` after a failure or expiry.

Only one job for a game may be queued or recording at once. Repeated clicks are
rejected. Queue priority and FIFO within each priority group still apply.
Rescoring reuses the original submission job and attribution when possible.
An imported game gets a job with `submission_credit=0`, preventing maintenance
from awarding submission leaderboard credit. No rescore changes daily usage.
An expired rescore does not erase credit for the game's original accepted
submission or remove the saved game from player statistics.

The game panel shows queued position, recording status, successful refresh time,
or failure while keeping old results accessible. Image-card cache keys already
include score and upgrade data, so a successful replacement refreshes the card.
The existing #recent message refreshes automatically after a successful rescore.
Other historical Discord attachments remain snapshots; reopen their panel for current results.

## Notifications and persistence

The requesting owner receives the rescore completion/failure notice. Ordinary
submission notifications still go to the submitter. A notification generation
distinguishes repeat completions and failures; retries within one generation use
the same nonce. A late acknowledgement from an older send cannot mark a newer
notification delivered. An unsent old notice is superseded when rescoring is
queued.

The additive migration preserves existing jobs, daily usage, results, and DM
state. `jobs.submission_credit` defaults to 1 for old jobs;
`jobs.rescore_requested_by` defaults to null; `completion_dms.generation`
defaults to 0. Interrupted recordings recover into the queue with the rescore
target and previous results intact.

Tests exercise successful and resource-only replacement, corrections made
during recording, void status, failure/expiry/cancellation, duplicate guards,
imported games, schema migration and restart recovery, notification races,
owner-only commands/buttons, and image/text controls. Deployment registers 37
global commands and restarts the service between recordings.
