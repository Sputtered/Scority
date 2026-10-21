# Scority admin panel

## Bot connection and controls

For concurrent scoring, set `MINECRAFT_ACCOUNTS` to the Microsoft login emails
separated by commas, authenticate each with `npm run auth:account -- <number>`,
and restart the recorder. Bot control shows each account's Minecraft name,
connection, replay, and progress. Its replay buttons target that account only.
Connect, Disconnect, Reconnect, and queue pause apply to all accounts.
The account list is set in `.env`; the single-account identity setting is used
only when `MINECRAFT_ACCOUNTS` is empty.

`npm start` now connects the recorder to Minecraft directly. A separate desktop
Minecraft client is no longer needed in Discord mode. `npm run proxy` retains
the manual client workflow. The managed recorder currently supports Minecraft
1.8.9, matching the replay automation packet adapter.

Open **Bot control** for Connect, Reconnect, Disconnect, auto rejoin, queue
pause/resume, restart/skip current replay, and return to lobby. Connection status
refreshes every three seconds, with the last disconnect reason, next retry time,
last received packet, and recent connection events. A missing 15-second heartbeat
is displayed as an offline service; commands are rejected until the bot process
is running again. The website does not launch an operating-system service.

Auto rejoin defaults to on. Kicks, socket errors, login/spawn timeouts, silent
connections, and halted automation are handled by one connection supervisor.
Retries start at 10 seconds and increase to a 2-minute maximum, with jitter.
A minute of healthy connection resets the backoff. Disconnect from the website
persists an intentional offline state until Connect is pressed again.
Interrupted jobs are requeued without charging another submission spot; after
five disconnect retries they fail and remain available for manual retry. Partial
recordings are never published as completed games.

**Settings** exposes 39 validated, searchable settings across connection recovery,
server/account, view distance, scoring filters/color aliases, recorder timeouts,
replay speed and menu timing, anti-idle movement, submission limits, card styles,
notifications, and the recent-games channel. The form marks when each setting
applies. Settings persist in SQLite, use concurrency checks, and can be exported
as JSON or reset to defaults in the form before saving. Account changes can
require Microsoft device sign-in in the bot's terminal. Secrets remain in the
host environment and authentication cache.

**Replay queue** adds submission, cancellation, retry, and searchable job history.
**User controls** manages priority, unlimited submissions, and today's usage.
**Names & reviews** manages nickname/alt links and approves/rejects name requests.
**Activity log** records administrative changes. Existing game editing, history
restore, voiding, rescoring, and exports remain available in Games.

The website and bot communicate through their shared database. Commands expire
after 30 seconds and pending/running commands are failed on recorder restart,
so an old reconnect/skip cannot execute unexpectedly later. All new endpoints use
the same session, Origin, and CSRF checks as game editing.

Run `npm run web` with `SCORITY_WEB_KEY` set in `.env.web`. The web process uses
the same `REPLAY_DATABASE` as the Discord bot; it does not start another recorder
or Discord client. Default listener: `127.0.0.1:3080`.

The panel includes a searchable, paginated game-card library, a player directory,
queue pause/resume controls, and per-game editing for names, teams, kills, deaths,
final kills, beds, longest streaks, diamonds, emeralds, winner, duration, review
note, void state, and team upgrade times. K/D, W/L and aggregate totals are derived
from the edited games. Combat event JSON can also be corrected; the explicit
recalculate button copies event counts into the scoreboard draft. Head-to-head
kill/death breakdowns follow the combat events. Recorded PvP damage appears in the
scoreboard and player directory as whole HP; damage values are read-only and keep
their original precision in storage. Admin saves and history restores also refresh
the original #recent image, normally within 10 seconds. Rescores and Discord-side
name/winner changes use the same persistent refresh path.

Edits are atomic, use optimistic concurrency, and are recorded in
`game_admin_history`. The history tab restores the state before an edit, and the
restore itself is another history entry. Raw recordings remain unchanged.
`game_stat_edits` overlays only changed stat fields before name projection, so
Discord cards and aggregates see the same corrected data. Unedited fields can
still improve when a game is rescored; edited fields survive. A rescore that
omits a player with a stat correction is rejected. Original submission credit,
daily usage, game IDs, and chronology remain intact.

Authentication is enforced on every data, image, export, and mutation endpoint.
Sessions last eight hours and use HttpOnly, SameSite=Strict cookies, with Secure
cookies for HTTPS. Mutations require an exact Origin and a session CSRF token.
Login attempts are limited by source IP and globally. The password is only read
on the server; it is not included in browser assets or logged. Public origins
must use HTTPS. The listener stays on loopback behind nginx, which sets the
trusted client-IP header. The website intentionally exposes no database download,
filesystem browsing, arbitrary SQL, or shell execution endpoint.

For a public deployment set `SCORITY_WEB_ORIGIN=https://<host>` and
`SCORITY_WEB_PROXY=1`; set nginx to forward to 127.0.0.1:3080 with the public Host
and `X-Real-IP $remote_addr`. HTTP redirects to HTTPS. TLS certificates need
automatic renewal and an nginx reload hook. IP certificates can be provisioned
using Certbot's `--ip-address` and `--preferred-profile shortlived` options; see
[Let's Encrypt's Certbot guidance](https://letsencrypt.org/2026/03/11/shorter-certs-certbot).

Restart the bot once after installing this release so its store decoder also
applies stat edits. The web service itself can restart independently. Back up
the SQLite database before deployment. Tests cover auth, CSRF, session expiry,
rate limits, validation, concurrent edits, rollback, history restore, rescore
preservation, image rendering, aggregates, and queue integration.
