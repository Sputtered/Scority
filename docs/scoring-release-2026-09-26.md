# Damage, diamonds voided, and connection fixes

## Scoring

- Damage version 2 matches hurt and health evidence by replay-adjusted timing and packet order. It uses positions captured around the hurt and swing, and excludes dead-player evidence until a new life begins.
- A username containing `Void` no longer qualifies an ordinary death for void-finish damage. Server-credited void finishes still use the victim's known remaining HP once.
- Repeated player drops from the same spot no longer become generator spawns.
- Resource accounting reconciles stack merges so the same physical diamonds are not subtracted twice. Uncertain collection amounts remain unavailable.
- `diamondsVoided` follows identified player releases through movement below the recorded world floor, without a pickup. Merge ownership, stack quantities, entity reuse, delayed metadata, and incomplete captures are handled conservatively.

The diamond item with the barrier item drawn over it identifies diamonds voided on the website and image cards. Profiles, per-game details, text views, exports, and aggregates include the stat. The owner can correct it through the scoreboard editor. Older games without this evidence show a dash; tracked zero remains zero.

Damage attribution and throw ownership remain inferred from replay packets. More attributed HP measures increased coverage, not measured accuracy. Unsupported projectile, absorption, and missing lethal damage are not filled in with guesses.

See [damage rules](player-damage.md), [diamonds voided rules](voided-diamonds.md), and [safe historical backfill](scoring-backfill.md).

## Connection and control

- Headless viewer timers are always cleaned up when a session closes, including authentication failures before a socket exists.
- Late authentication callbacks and transports from an abandoned session cannot affect a replacement recording.
- Dashboard commands, recorder checks, and Discord settings application run independently. The website distinguishes process availability, command-processor health, and pending Discord settings.
- Replay HUD load failures receive one retry by default. The website setting allows 0–5 retries; the budget survives restarts and uses the existing job and submission quota. Explicit invalid replay responses do not retry.

The changes have regression coverage for the reproduced review failures and additional merge, lifecycle, and manual-edit cases. Card layouts and the local website were rendered and visually inspected before release.
