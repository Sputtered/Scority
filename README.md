# Scority

> **Note:** This README was written by AI.

A Discord app for submitting Hypixel Bed Wars replays, recording them with a
managed Minecraft 1.8.9 connection, and exploring player stats. Results, queue
state, limits, and permissions live in a local SQLite database. New users should
start with [START-HERE.md](START-HERE.md).

## Features

- **Replay queue**: `/submit` a replay ID. Each user gets five submissions per
  Pacific calendar day, priority users go first, and the queue survives restarts.
- **Stats**: `/stats`, `/matchup`, `/compare`, `/rivals`, `/teammates`, and
  `/leaderboard` cover wins, losses, kills, finals, beds, assists, and damage.
- **Image cards**: PNG cards for players, games, matchups, and leaderboards in
  several styles (`inventory`, `carbon`, `arena`, `studio`, or `off`).
- **Name management**: the owner can link nicks and alts to a main name, and
  users can request per-game name changes.
- **Owner tools**: void/unvoid games, `/setwinner`, `/rescore`, `/retry`,
  `/pause`, and an optional local admin website.
- **Multiple recorder accounts**: these share one queue.

## Setup

Requires **Node.js 22.13+** (Node 24 recommended), a Discord application, and a
Minecraft account that can view the replays.

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
   Enable User and Guild Install with the `applications.commands` and `bot` scopes.
   Leave the Interactions Endpoint URL empty. The app uses the Gateway.
2. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN`,
   `DISCORD_APPLICATION_ID`, `DISCORD_OWNER_ID`, and `MINECRAFT_USERNAME`.
   Never commit or share your token.
3. Install, register commands, and start:

   ```sh
   npm ci
   npm run register
   npm start
   ```

4. Open the install link that registration prints. On first connection, sign in
   to Microsoft with the device code shown in the terminal.

For multiple accounts, set `MINECRAFT_ACCOUNTS` to a comma-separated list of
Microsoft logins. Sign in to each one with `npm run auth:account -- 1`,
`npm run auth:account -- 2`, and so on.

Run `npm run register` again whenever command definitions change.

## Common scripts

| Script | Purpose |
| --- | --- |
| `npm start` | Run the Discord bot and recorder |
| `npm run register` | Register global slash commands |
| `npm run web` | Start the optional admin website |
| `npm run import [-- dir]` | Import old `replay-*.json` exports |
| `npm run preview:cards` | Regenerate card style previews |
| `npm test` | Run the offline test suite |

## Data

- `data/replays.sqlite` is the source of truth. Override its location with
  `REPLAY_DATABASE`. Stop the app before backing it up.
- `mc-auth-cache/` holds Minecraft sign-in tokens, so keep it private.
- `.env`, `data/`, `output/`, `captures/`, and `mc-auth-cache/` are git-ignored.

## Docs

- [Admin website](docs/admin-web.md)
- [Assists and public games](docs/assists-public-games.md)
- [Rescoring](docs/rescoring.md)
- [Player damage](docs/player-damage.md)
- [Extended stats](docs/extended-stats.md)
- [Team upgrades](docs/team-upgrades.md)
- [Replay packet validation](docs/replay-packet-validation.md)
