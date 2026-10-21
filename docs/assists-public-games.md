# Assists and public games

Assists are derived from attributed PvP damage and the kill feed. A helper must
deal at least 2 unrounded HP within the inclusive 10-second window before the
victim dies, and belong to the credited killer's team. The killer, the victim,
players from other teams, unassigned damage, and environmental deaths cannot
receive assists. Multiple eligible helpers can each earn one assist. Credited
void kills accept preceding combat contributions; void loss and remaining-HP
awards themselves cannot establish a helper's contribution.

New kill events carry the damage tracker's packet sequence and victim life ID.
These prevent damage from leaking across respawns, even within one HUD second.
Older released damage audits use kill-feed time boundaries and the latest
observed victim life; ambiguous damage at the previous death's timestamp is
excluded. Replay time, not recording speed or wall-clock time, defines the window.
Missing or ambiguous damage evidence can miss assists; these are replay-derived
statistics rather than a server-provided assist counter.

`players.*.assists` and `assistsByOpponent` hold totals. `tracking.assists` records
the version and rule; `tracking.assistEvents` records helper, victim, killer, time,
life, and contributing HP. `applyAssists` runs on new match export and again after
admin edits on read, before name projection. Original database score payloads are
preserved. Team/kill-feed corrections, name edits, rescoring and undo therefore
remain consistent with #recent and player totals. Missing damage audits stay
unavailable, rather than becoming zero assists. Assist counts are read-only in
the admin scoreboard; edit their underlying team/kill evidence when necessary.

Supported canonical teams are `red`, `blue`, `green`, `yellow`, `aqua`, `white`,
`pink`, and `grey`. Minecraft `light_purple`/`dark_purple` map to Pink; `gray` and
`dark_gray` map to Grey. Rosters and observed team-elimination messages determine
participating teams and the final surviving team. Public matches never declare
a winner merely because one team loses all members. Incomplete elimination
evidence leaves the winner pending for owner review. Legacy two-team matches
retain the last-final-kill fallback.

Cards support the full 16-player Doubles or 4s roster and 12-player 3s roster.
Public cards arrange all team panels in two columns; detail cards list every
opponent. Original Minecraft textures and bitmap numbers are retained. Existing
private cards without assist evidence keep their original columns; supported
damage audits acquire an Assists column and refresh in place in #recent.
Combat icons use vanilla iron sword (kills), arrow (assists), skeleton head
(deaths), and diamond sword (final kills). The head is rendered from the original
1.8.9 skeleton atlas. Published cards refresh in place for the new icons.
