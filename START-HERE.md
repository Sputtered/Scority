# Run your own Scority

This is the source snapshot from September 28, 2026, with setup changes for an independent installation. The project package version remains 0.1.0. There is no Git repository or upstream release URL in the supplied folder, so a newer upstream or deployed copy has not been verified.

## Requirements

- Node.js 22.13 or newer. This package was checked with Node 24.21.0.
- Your own Discord application and bot token.
- Your own Microsoft account with Minecraft Java and access to the Hypixel replays you want to record.
- Internet access to install dependencies and use Discord/Minecraft.

## First run

1. Extract the ZIP and open a terminal inside this folder.
2. Copy .env.example to .env (PowerShell: `Copy-Item .env.example .env`; macOS/Linux: `cp .env.example .env`).
3. Edit .env and fill in DISCORD_TOKEN, DISCORD_APPLICATION_ID, DISCORD_OWNER_ID (your Discord user ID), and MINECRAFT_USERNAME (your Microsoft login email). To copy your Discord user ID, enable Developer Mode in Discord, then right-click your account and choose Copy User ID.
4. Follow **Discord setup** in README.md to enable user/server installation for your application.
5. Run the following commands. If PowerShell blocks npm.ps1, use npm.cmd instead of npm.

```sh
npm ci
npm run register
npm start
```

Registration replaces the global commands of the application you configured. Use your own application dedicated to Scority. Open the installation link printed by registration.

Follow the Microsoft sign-in instructions printed in the terminal on the first connection. Keep the terminal running. Windows users can use run.bat after the first setup. No compile step is needed.

## Optional admin website

Create .env.web with SCORITY_WEB_KEY set to a long random password. Run `npm run web` in a second terminal and open http://127.0.0.1:3080. Keep `npm start` running for recording. See docs/admin-web.md for deployment details.

## Checks and multiple accounts

Run `npm test` for the offline test suite. It uses a synthetic owner ID and temporary databases. Run `node test/dry-run.js` for the scoring dry run. See README.md for MINECRAFT_ACCOUNTS and per-account authentication.

## Included and excluded

Included: application source, locked dependency versions, required images/fonts, documentation, tests, Windows launchers, and a blank configuration example. The shareable copy makes the owner configurable and validates owner/account setup before starting. Your running installation was not changed.

Excluded: .env files with credentials, Microsoft token caches, databases, recordings, captures, generated previews, node_modules, and local development/deployment files. The one-off preview-damage-cards script depended on private captures and is omitted. Other previews can be generated with npm run preview:cards.

Each installation creates its own data/, output/, and mc-auth-cache/ folders. Keep .env, .env.web, and mc-auth-cache private. Stop the app before copying its database for backup.

Font license files and Minecraft asset attribution are included under assets/. No new software license is assigned by this package.
