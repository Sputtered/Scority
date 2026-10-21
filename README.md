# Scority

For this source package, start with [START-HERE.md](START-HERE.md).

A Discord app for submitting Minecraft replays, watching the recording queue,
and exploring player stats. It runs on the same machine as the Minecraft
recorder. Its managed Minecraft 1.8.9 connection views the queued Hypixel replays;
results, permissions, submission limits, and queue state live in local SQLite.
**The Discord app does not use the website or pipeline API.**

Games support private Red/Green and Red/Aqua matches, eight-team public Doubles
(Red, Blue, Green, Yellow, Aqua, White, Pink, Grey), and four-team public 3s/4s
(Red, Blue, Green, Yellow). Teams come from recorded chat and scoreboard colors.
Public results use a grid of team panels with original Minecraft wool and fonts;
all players have #recent buttons. `/setwinner` and the admin site support every team.

Assists require at least 2 HP of attributed damage within 10 replay seconds
before a teammate kills the opponent, including credited void kills. Each helper
gets one assist per victim death; the killer and rival teams get none. Cards,
player totals, opponent details and the admin site show assists. Saved games with
damage events gain assists automatically; games without evidence show a dash and
need rescoring. See [assists and public games](docs/assists-public-games.md).

## Discord setup

Requires **Node.js 22.13+** (Node 24 recommended), a Discord application, and a
Minecraft 1.8.9 account able to view the submitted replays.

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Under **Installation**, enable **User Install** and **Guild Install**.
   Select **Discord Provided Link**. For User Install, enable
   `applications.commands`. For Guild Install, enable `applications.commands`
   and `bot`; Send Messages, Embed Links, and Attach Files are sufficient.
   No Administrator permission or privileged gateway intents are required.
3. Under **Bot**, generate a bot token. Copy the Application ID from
   **General Information**. Leave the **Interactions Endpoint URL empty**:
   this app receives commands through Discord's Gateway, so no public website,
   HTTP listener, port forwarding, or public-key setting is needed.
4. Copy `.env.example` to `.env`, then fill in `DISCORD_TOKEN`,
   `DISCORD_APPLICATION_ID`, `DISCORD_OWNER_ID`, and `MINECRAFT_USERNAME`. Keep the token in that
   local file; do not post it in Discord or chat.
5. Install dependencies and register the global commands:

   ```sh
   npm ci
   npm run register
   npm start
   ```

   `npm run register` replaces this application's global command list with
   the 38 commands in this project. Use an application dedicated to Scority.
6. Open the install link printed by registration and select **Add to My Apps**.
   Users can then invoke the commands in the bot's DMs, other DMs/group DMs,
   and server channels where Discord permits external apps. Commands are global,
   so allow time for Discord clients to refresh their command list.
7. The recorder connects automatically. Its first connection may prompt for
   Microsoft device-code authentication in the terminal. A separate Minecraft
   client is not required. Use the website's **Bot control** page to reconnect,
   disconnect, or toggle auto rejoin; **Settings** has persistent controls for
   connection recovery, replay recording, submissions, and Discord.
   See [the admin panel guide](docs/admin-web.md).
8. Anyone can open `/help` and press **Submit replay**, or use `/submit` directly.
   Each person gets five accepted replay submissions per Pacific calendar day.

The Windows launchers `run.bat` and `run-debug.bat` also start the Discord app.
Run `npm run register` again after changing command definitions. Neither tests
nor startup register commands automatically.

### Score with multiple accounts

Set `MINECRAFT_ACCOUNTS` in the local `.env` to a comma-separated list of Microsoft
login emails. This replaces the single `MINECRAFT_USERNAME` recorder. Each account
gets its own connection, token cache, and active replay; the shared queue assigns
different replays in priority order. Run one Scority process for the database.

Before starting the service, sign in to each account with `npm run auth:account -- 1`,
then `npm run auth:account -- 2`. Open the Microsoft link and enter the displayed
code using the matching account. Passwords are not stored by Scority. Keep
`mc-auth-cache/` private because it contains the saved sign-in tokens.

`/status` and the website's **Bot control** show each account and its replay.
Pause lets all recordings finish. Connect, Disconnect, and Reconnect apply to
all accounts; each recorder has its own replay restart, skip, and lobby buttons.
An interrupted job returns to the shared queue, so either free account can retry it.
With `MINECRAFT_ACCOUNTS` set, change account identities in `.env` and restart;
the website's single-account identity setting applies only to single-account mode.

Discord's [user-install guide](https://docs.discord.com/developers/tutorials/developing-a-user-installable-app)
and [interaction-context reference](https://docs.discord.com/developers/interactions/receiving-and-responding)
explain these installation surfaces and platform restrictions.

## Commands and controls

Replies are private to the person using the command. Panels include navigation,
refresh, pagination, replay selection, and contextual controls. Buttons verify
the clicking user's identity; owner controls also check the fixed owner ID. Panels
expire after two hours or a restart; reopening a command restores the view.
The bot uses yellow embeds and short, plain-language labels. When your replay
finishes scoring, it sends you a DM with **View results** and **My replays** buttons.
If Discord blocks the DM, your results stay available in **My replays**. Depending
on Discord's privacy and app-access rules, you may need to allow DMs or share a
server with the bot. See Discord's [DM API notes](https://docs.discord.com/developers/resources/user#create-dm).

DMs are sent for newly completed submissions and replay IDs that Hypixel reports
as missing, not old imported games. Pending
messages survive a restart. Temporary errors get up to three attempts; blocked
DMs are not retried. Sending a DM never holds up the recording queue. After an
uncertain network failure, Discord's duplicate-message check helps avoid repeated
messages, but delivery cannot be guaranteed exactly once across long outages.

After updating the bot, run `npm run register` to refresh command descriptions,
then restart the bot to load the new text, theme, and DMs.

| Commands | What they do |
| --- | --- |
| `/help` | Home panel, quick actions, command guide, and access instructions |
| `/submit [replay]` | Submit an ID or `/replay <id>`; opens a form when omitted |
| `/queue`, `/status` | Queue positions, active recording, HUD progress, and connectivity |
| `/limit` | Remaining daily submissions and the next reset |
| `/myreplays` | Your waiting, recording, completed, failed, invalid, and cancelled submissions |
| `/recentgames` | Paginated completed-game library |
| `/replays user:<IGN>` | Every recorded game containing that Minecraft name |
| `/replay replay:<ID>` | Scoreboard or submission status, with contextual buttons |
| `/stats user:<IGN>` | Career wins, losses, W/L, kills, deaths, finals, beds, streaks, and recent form |
| `/matchup user1:<IGN> user2:<IGN>` | Opposing-team wins/losses and direct kills/deaths |
| `/compare user1:<IGN> user2:<IGN>` | Compare both players' overall recorded statistics |
| `/rivals user:<IGN>` | Frequent opponents and their head-to-head records |
| `/teammates user:<IGN>` | Frequent teammates and shared win/loss records |
| `/leaderboard [metric] [minimum_games]` | Top 10 K/D ratios, W/L ratios, or replay submitters; switch lists with the dropdown |
| `/export replay:<ID>` | Download a completed game's scored JSON |
| `/cancel replay:<ID>` | Confirm cancellation of your own waiting submission |
| `/void replay:<ID> [reason]` | Owner: void a scored game and remove it from all stats and leaderboards |
| `/unvoid replay:<ID>` | Owner: restore a voided game |
| `/names [user]` | Browse saved nick and alt links, optionally for one main name |
| `/myrequests` | Check whether your name change requests were approved or rejected |

K/D and W/L leaderboards rank Minecraft players and honor `minimum_games`.
Submission rankings count each Discord user's unique accepted replay submissions,
excluding invalid and voided replays. Retrying a replay does not add another submission;
cancelling one does not erase the submission. Only the top 10 appear on each list.
The help panel shows owner commands and the owner menu only to **the configured DISCORD_OWNER_ID**.

If Hypixel sends **Couldn't find a replay by that UUID!** while a replay is loading,
the bot marks it invalid, saves a DM notice for its submitter, and advances to the
next queued replay. It does not save a game or count it in game stats. The original
submission still uses its daily spot. The notice and invalid status remain in
**My replays** even if Discord blocks the DM.

Newly scored and imported replays must be at least **180 seconds (3 minutes)** long.
The check uses the replay's total duration, regardless of playback speed or time
spent waiting in the queue. Exactly 180 seconds qualifies. Short replays are skipped
as soon as their length appears in the replay HUD, and the finished result is also
checked before saving a scored game. Missing or invalid duration prevents scoring.
The submitter gets a saved DM notice, the queue continues, and the submission still
uses a daily spot. Previously scored games are kept unless you void them.

Only **the configured DISCORD_OWNER_ID** can void or restore games. Use `/void` with an optional
reason, or press the red **Void game** button on a game. The game stays viewable
with a **Game voided** label on its card and export, but leaves player stats,
matchup stats, teammates, rivals, and all three leaderboards. Its original recording,
name changes, and winner corrections stay saved. `/unvoid` or **Restore game** puts
it back, subject to any remaining name conflicts. Both actions are saved in `/audit`.

Player options are **Minecraft IGNs**, not Discord accounts. Autocomplete helps
find recorded names and replay references. Names are matched case-insensitively;
the owner can link nicks and dedicated alts to a main name. No account ownership
is guessed from a name or looked up automatically.
`R00001` refers to a submission; `G00001` refers to a completed game. You can also
look up the original replay ID.

Only **the configured DISCORD_OWNER_ID** can use these controls (server administrators do
not automatically receive owner access):

| Owner command | Action |
| --- | --- |
| `/priority [user] [enabled]` | List priority users; select a user to grant priority, or `enabled:false` to remove it |
| `/resetlimit id:<Discord ID>` | Reset that user's five daily replay spots |
| `/pause`, `/resume` | Pause after the current recording or resume the queue |
| `/retry replay:<ID>` | Requeue a failed/cancelled submission without another quota charge |
| `/rescore replay:<ID>` | Record a saved game again and replace its scores after success; no new quota charge |
| `/setwinner replay:<ID> team:<red/green/unknown> [reason]` | Correct/confirm the winner and immediately update stats |
| `/nickadd nick:<name> main:<name>` | Link a nick in past and future games |
| `/nickremove name:<name> [revert]` | Remove a nick link; undo history by default, or keep history with `revert:false` |
| `/alt alt:<name> main:<name>` | Link an alt that belongs to one player in past and future games |
| `/altremove name:<name> [revert]` | Remove an alt link with the same history choice |
| `/setname replay:<ID> user:<recorded name> main:<name>` | Credit a player to another name in just this game |
| `/resetname replay:<ID> user:<recorded name> [mode]` | Use the original name by default; `mode:follow` restores normal nick/alt links |
| `/requests` | Review pending name changes with Approve, Reject, and View game buttons |
| `/admin`, `/audit` | Dashboard, name conflicts, pending requests, and recent changes |

Copied replay commands can include a time marker, such as
`/replay 8dcb02bb-6e61-4c0f-a435-40e1712f4661 #14cb857e`.
The bot removes the `#14cb857e` part and scores the replay from the beginning.
Different time markers on the same replay still count as the same replay.
This also works when entering commands in the terminal.

Use `/rescore replay:G00001`, a submission reference such as `R00001`, or the
original replay ID to refresh a saved game with the current scoring rules. The
owner also sees **Rescore game** on finished-game panels. Only one recording for
that game can wait or run at a time. It follows normal queue priority, keeps the
same game ID, and does not add another game or submission to leaderboards.
Previous results remain available until a valid full recording replaces them.
Name corrections, winner overrides, void status, and the original game date stay
in place; the previous raw score is archived locally. Expired replays and failed
recordings leave saved results intact. The requesting owner receives the result
notice. See [rescoring behavior](docs/rescoring.md).

## Image cards and style previews

`/stats`, `/leaderboard`, and finished-game views include Scority PNG cards. Player cards show
wins, losses, and W/L (wins divided by losses). With wins and no losses, W/L equals the win count; with no wins or losses, it is `0`. Completion DMs include
the game card too. Existing navigation and correction buttons remain available;
**Show text** opens the complete text results. If a card cannot be made, the bot
keeps the text view. Games with conflicting name links keep their warning and
text scoreboard until corrected.

Leaderboards use a wide top 10 image with two columns, five ranks per column, and
a highlighted first place. K/D and W/L lists include Minecraft avatars. The
submissions list shows Discord names and initials, with user IDs underneath;
Discord names are never treated as Minecraft names. If a Discord name cannot be
loaded, the card shows a user label and their ID. Use the dropdown to switch
metrics, **Refresh** for current rankings, or **Show text** for the accessible list.
These cards follow `REPLAY_CARD_STYLE`, including `off`, and keep the red Back button.

On a finished game, press **Game matchups** to see a second image card.
Choose a player from the menu to see their kills, deaths, and K/D against each
opponent in that replay. Opponents with no direct kills still appear with zeroes.
These counts come from that game's kill feed, respect owner name corrections,
and leave out teammate kills, environmental deaths, and players with no recorded
team. They do not include any other games. **Game results** returns directly to
the scoreboard, and **Show text** gives the same matchup numbers in text form.

Panels now have a red **Back** button after navigating from another panel.
It restores the previous view and page, including whether you were using images
or text. Refresh keeps that history. **Previous** and **Next** still move through
list pages. Back controls belong to the person who opened the panel and expire
with its session, after two hours or a bot restart.

Open `previews/cards/index.html` locally to compare player, game, matchup, and leaderboard examples,
change preview width, or open each PNG at full size. All preview stats are
fictional and marked **SAMPLE DATA**. They never enter the database.
Regenerate the examples with `npm run preview:cards` (this fetches public avatars).
The gallery is only a local design review file; running the bot needs no website.

Inventory is the selected default, using Minecraft 1.8.9 item, block, and font
textures. Player cards are 1408x580; game cards grow to fit the roster. Diamond
and emerald totals have their own textured columns. Each team's game card also
shows Sharpness and P1–P4 under **Est. acquired by**. These are provisional combat
estimates, not purchase timestamps; unsupported levels and historical games
without evidence show a dash. See [team upgrade timing](docs/team-upgrades.md).
Set `REPLAY_CARD_STYLE` in
`.env` to one of:

- `inventory`: Minecraft inventory slots, wool team banners, and resource columns.
- `carbon`: dark charcoal, warm yellow, rounded panels.
- `arena`: bold condensed headings, sharper panels, a win/loss strip.
- `studio`: Studio’s left profile panel, Carbon colors, and a wider layout.
- `off`: use text embeds only.

To mix styles, set `REPLAY_PLAYER_CARD_STYLE` and `REPLAY_GAME_CARD_STYLE`
separately. These override the shared setting. Restart the bot after changing
styles; command registration is not needed for card changes.

The bot requests public Minecraft head avatars from [MCHeads](https://mc-heads.net/)
using the player names from the corrected scoreboard. It does not use skins to
infer identity. Only the name is sent to that service, never replay data or
Discord credentials. The images show current skins, not necessarily the skins
worn during a historical replay. The avatar cache lasts 24 hours; failed requests
use a generic icon and can retry after five minutes. Download time and size are
bounded so a failed avatar service does not block scoring.

Cards use bundled Lato and Barlow Condensed fonts from
[Google Fonts](https://github.com/google/fonts), with their OFL licenses in
`assets/fonts/`. [Canvas](https://github.com/Brooooooklyn/canvas) renders the
images locally. The renderer uses actual stats, handles missing results without
creating losses, and refreshes its image cache when scores or name links change.
No image-generation service is needed while the bot is running.

## Nicks, alts, and name changes

Try not to use nicks/alts. Use your main.
Embeds and forms repeat this reminder.

For a nick, the owner can run `/nickadd nick:HiddenNick main:Sputtered`.
For an alt used only by that player, use `/alt alt:PrivateAlt main:Sputtered`.
Both commands update all matching saved games immediately and apply to future
recordings. Running the command again can correct an existing link.
Stats, matchups, teammate records, leaderboards, scoreboards, and downloaded
results all use the same corrected names. Kills, deaths, teams, and winners
stay attached to the same replay participant.

For a **shared alt**, open a finished game and press **Request name change**.
Choose the name shown in the original replay, enter the main name, and explain
who used the alt. The owner receives a DM with **Approve**, **Reject**, and
**View game**. Approval changes only that game. Scores do not change while a
request is waiting. `/myrequests` shows its status; `/requests` lets the owner
review it even if the DM was blocked. Pending requests and DM retries survive
a restart. Duplicate pending requests for the same game/player are blocked,
and each user can have up to five requests waiting.

The owner sees **Change a name** on games and can edit them directly without
submitting a request. `/setname` does the same thing. A game-specific edit takes
priority over a global link for the recorded name. If its chosen main account
is later linked to another main, that account link is followed as well.
Requests made before a game's names changed must be rejected and checked again,
so an old Approve button cannot overwrite a newer correction.

Removal has two choices:

- `/nickremove name:HiddenNick revert:true` (the default) removes the link and
  undoes its effects in saved games. `/altremove` works the same way. Independent
  edits made for one game remain in place.
- `revert:false` removes the link for future games but keeps current names in
  saved games as individual game edits. `/resetname` can undo those later.

`/resetname replay:G00001 user:HiddenNick` uses the original recorded name in
that game, even if a global link exists. Add `mode:follow` to remove the game
edit and follow the global links again. An original-name exception has its own
stats under the original name; use the main name to see the main account's
stats. Otherwise, looking up a linked nick or alt opens the main profile.

The original saved replay JSON and its duplicate-detection fingerprint are
never rewritten. Name corrections are stored separately and applied when
reading results. Exports include `nameLinks` with original names, chosen names,
and any conflicts; captured chat text stays unchanged as a record of the replay.

A name change is rejected if it would combine two different players in a saved
game, even when they are teammates. Nothing from that change is saved. If a new
recording exposes such a conflict, its scoreboard keeps the original names,
shows **Names need a fix**, and stays out of all aggregate stats until corrected.
The owner can find these games in `/admin` and use `/setname` or `/resetname` to
fix them. Global links point directly to main accounts; a main already used by
other global links cannot become an alias until those links are moved or removed.

## Queue and daily-limit rules

- Users get **five accepted submissions per Pacific calendar day** by default.
  The owner can grant `/nolimit user:<Discord user>` until revoked with
  `enabled:false`. Usage still counts, so revoking immediately restores the
  remaining daily allowance. `/resetlimit` resets usage without removing exemptions.
- Reset is midnight **America/Los_Angeles**, respecting daylight saving time.
  Limits are global per Discord user, across all servers and DMs.
- Duplicate replay IDs are rejected without charging usage. A cancelled or
  failed submission still counts for that day; only the owner can retry/reset.
- Positions include the active recording at #1. Priority users' waiting jobs
  come first, then standard jobs; each group follows submission order. Priority
  changes reorder waiting jobs immediately and never interrupt the active job.
  Retries go to the back of their current priority group.
- Submissions are saved while Minecraft is offline. Queue entries, priority users,
  pause state, limits, and results survive process restarts.
- A crash requeues the interrupted job on next startup. Disconnects and kicks
  automatically reconnect and requeue the interrupted recording by default,
  with five automatic replay retries before marking it failed. Limits and
  delays are configurable from the website.
- A replay that never loads its HUD gets one retry through the lobby after two
  minutes, then fails if it still cannot load. The website can set 0–5 load
  retries. Explicit "replay not found" responses are skipped without retrying.
  Retry budgets survive restarts and do not charge another submission. A loaded
  recording has a 90-minute maximum. The automator returns to the lobby and advances.
- Dashboard commands and recording checks run independently of Discord publishing
  changes. The dashboard reports command and recorder check health separately from
  the process heartbeat, and shows when Discord settings are still being applied.
- Connection/serialization errors close that session and schedule a fresh
  connection. The Discord bot remains available to inspect status.
- Only one recorder process may use a database. Discord mode owns its Minecraft
  connection; standalone proxy mode still accepts one desktop client at a time.

## How stats are calculated

Only completed, nonempty recordings enter the library. Stats use the parsed
replay JSON, not live Minecraft account lookups. `/matchup Sputtered Mikowa`
counts wins and losses from Sputtered's perspective **only when both have known,
opposing teams**, then counts kill-feed events between those two players.
Teammate games and games with unknown teams are listed separately. Unknown
winners are excluded from wins, losses, and win-rate denominators.

The recorder infers a winner from four distinct final deaths on one team, or
falls back to the last final killer's team. Embeds label inferred results;
`/setwinner` lets the owner confirm/correct them. Updated results immediately
flow through matchup, player, teammate, and leaderboard views. Ratios use a minimum
divisor of 1: 1 kill and 0 deaths gives `1.00` K/D, and 1 win and 0 losses gives
`1.00` W/L. With both totals at zero, the ratio is `0.00`.

Chat parsing, team assignment, and winner inference can still be imperfect.
Seeking may skip events or defeat timestamp-based deduplication. Record replays
straight through from the beginning and review warnings on questionable games.

## Local data and existing recordings

`data/replays.sqlite` is the source of truth. Override its location with
`REPLAY_DATABASE` in `.env`. Stop the app before copying this database for a
backup; live SQLite also uses `-wal` and `-shm` sidecar files. The `.lock` file
prevents competing recorders and is released on normal shutdown.

Scored JSON copies remain in `output/session-<timestamp>/`. Auth tokens remain
under `mc-auth-cache/`. These paths and `.env` are excluded by `.gitignore`.
Debug summaries and `DEBUG_PACKETS=1` logging still work as before.

Import old captures with:

```sh
npm run import
# or another directory:
npm run import -- /path/to/old/output
```

The importer reads `replay-*.json` recursively, accepts only nonempty
`replay_finished` exports, and deduplicates by replay ID or event fingerprint.
Imports do not consume submission limits. Existing files are not modified.
Interrupted captures are skipped so partial games do not distort statistics.

## Development and standalone recording

### Local damage/resource packet tests

Use `npm.cmd` in Windows PowerShell if its execution policy blocks `npm.ps1`.

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run test:capture
npm.cmd run capture:replay -- --username Sputtered --replay 3dd626bb-1f78-4ef8-948a-7b820ca8114a --version 1.21.11 --auth-dir ./mc-auth-cache --spectator-movement
```

The capture tool connects as the named Minecraft account. Using an account that
is already connected elsewhere can disconnect that other session. It loads the
replay from the beginning, removing any copied `#time-marker`. When the HUD says
`paused 0/... 1x` and hotbar slot 4 says **Click to Resume**, enter `use 4` in the
terminal. Let it finish at 1x without seeking for the baseline. `stop` ends the
capture; `mark <note>` adds a local annotation. The default limit is 900 wall-clock
seconds, including connection/loading time; change it with `--max-seconds`.
`--spectator-movement` moves the viewer 0.1 blocks and back every two minutes,
following the existing recorder's movement approach. It leaves replay speed and
timeline controls alone. Without it, the stationary capture was kicked for
inactivity at replay time 05:18 in the initial test.
The modern idle loop sends position reminders once per second. With that change
and spectator movement enabled, the local 1.21.11 capture completed all 08:57
at 1x on 2026-09-24.

This standalone tool writes into a new `captures/<timestamp>-<version>/` folder.
It does not load `.env` or start the Discord app. Its default authentication cache
is `captures/auth`; `--auth-dir ./mc-auth-cache` explicitly reuses the copied cache.
Authentication packets are excluded. Gameplay packets still contain player names,
chat, and replay data, so capture folders are ignored by Git.

Analyze a finished capture with its actual folder name:

```powershell
npm.cmd run analyze:capture -- captures/<folder>/packets.jsonl.gz
```

Add `--partial` to inspect a capture still being written. The report lists raw
health changes, resource pickups, decoded ender-chest locations, nearby-player
candidates, death chat, and packet decoding failures. It does **not** calculate
verified damage-dealt or carried/credited resource totals. A nearby player is
not sufficient evidence of a throw, and death-transfer/pickup deduplication needs
a controlled example. Distances currently use 3D distance from the player's
position to the center of the ender-chest block, with an inclusive five-block bound.

Replay timestamps are the last HUD sample (whole seconds), with packet sequence
numbers preserved. Arrival times are diagnostics, not replay timestamps. Rewinds
start another observation epoch; health comparisons reset on a new epoch,
entity spawn, death chat, or world change. Healing is recorded separately.

The capture adapter has been exercised with 1.8.9 and 1.21.11. On 2026-09-24,
Hypixel rejected 1.19.4. Some 1.21.11 lobby inventory/particle frames did not match
the installed decoder; the diagnostic client preserves those complete raw frames
as `capture_unparsed` and continues with the next framed packet. The analysis
reports their packet types and whether playback was active. Do not treat a
partial/undecodable capture as complete evidence.

See [the local validation report](docs/replay-packet-validation.md) for packet
evidence and [extended replay statistics](docs/extended-stats.md) for the implemented
diamond/emerald crediting, Inventory cards, and 4x replay scoring.
New recordings also include [player damage](docs/player-damage.md): dealt and
received HP, per-opponent totals, and credited void finishes. Inventory cards
use the Minecraft bitmap font for the new numbers. Older games retain unavailable
values until rescored or backfilled from complete packet captures.

An optional [offline Protection experiment](docs/protection-estimator.md) compares
isolated sword hits with possible armor enchantment levels. Run
`npm.cmd run estimate:protection -- captures/<folder>/packets.jsonl.gz` to generate
candidate fits. Its ten-hit player estimates remain diagnostic; the separate
team timeline uses corroborated upgrade bounds from the same combat evidence.

```sh
npm test
node test/dry-run.js
npm audit --omit=dev
npm run proxy
```

`npm run proxy` retains terminal/manual operation without Discord. Only that
legacy mode honors `config.pipeline` settings; Discord mode never uploads or
polls the website, even if old pipeline environment variables remain set.

The tests use in-memory/temporary SQLite, mocked Discord interactions, real
queue/automation integration, and local Minecraft 1.8.9 sockets. They do not
log into Discord/Microsoft, contact Hypixel, register commands, or submit data.
Live Discord installation and Hypixel's menu timing still require a check with
your accounts after configuration.

Main modules:

- `app.js`: bot + recorder startup, process lock, recovery, and shutdown.
- `lib/discord/`: durable store, command definitions, interaction/UI handlers,
  aggregate stats, and the queue-to-recorder adapter.
- `proxy.js`, `lib/relay.js`: independent Minecraft connections, forwarding,
  recording lifecycle, and local exports.
- `lib/bot-orchestrator.js`: replay loading, menu timing, movement, and completion.
- `lib/death-parser.js`, `lib/actionbar-parser.js`, `lib/match.js`,
  `lib/team-colors.js`: chat/HUD parsing and per-replay scoring.

The transitive `uuid` dependency is pinned to `11.1.1` to fix its buffer-bounds
advisory. Offline tests cover both authentication consumers' UUID calls.

## Recent game cards

Set `REPLAY_RECENT_CHANNEL_ID=<your-channel-id>` to backfill every saved game
card, oldest first, then post new games automatically. Each post contains the
image plus every player's current IGN as plain, space-separated message content.
Name corrections update both the card and that text. Existing image-only posts
gain the name list without reuploading their images. SQLite receipts survive
restarts; rescoring does not duplicate a game.
Player-name buttons open a private game detail card for the person clicking,
with kills, deaths, K/D and PvP damage against each opponent. Buttons survive bot
restarts and name corrections. Games with more than 25 players have a More players
button for the remaining roster. Existing posts gain controls automatically.
The bot needs View Channel, Send Messages, Attach Files and Read Message History.
Uncertain sends are checked against this bot's exact attachment filename before
retrying. Missing history access stops a retry instead of blindly duplicating it.
Failures retry with backoff. Admin edits, restores, name/winner changes and rescores refresh the existing #recent message automatically, normally within 10 seconds. Receipts and card versions persist across restarts; refreshes never post a duplicate.

[Damage trials](docs/damage-trial.md) remain available for offline comparisons.
The [released player-damage scorer](docs/player-damage.md) runs automatically on
new recordings and appears on game cards, player details and career stats.
