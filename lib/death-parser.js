import {teamName} from './team-colors.js';

const KILL_RE = /^(\S+) (?:was|be) (.+?) by (\S+)\.(\s*FINAL KILL!)?$/;
const SOLO_DEATH_RE = /^(\S+) (?:fell into the void|died)\.(\s*FINAL KILL!)?$/;
const BED_RE = /^BED DESTRUCTION > (\w+) Bed was .+ by (\S+)!$/;

const ALT_KILL_RES = [
  /^(\S+) was (.+?) from (\S+)\.(\s*FINAL KILL!)?$/,
  /^(\S+) was (.+?) against (\S+)\.(\s*FINAL KILL!)?$/,
  /^(\S+) (.+?) while fighting (\S+)\.(\s*FINAL KILL!)?$/,
  /^(\S+) was (out of the league) of (\S+)\.(\s*FINAL KILL!)?$/,
];

// always final, even without the suffix
const FINAL_COUNTER_RE = /^(\S+) was (\S+)'s final #[\d,]+\.(\s*FINAL KILL!)?$/;

const LOOKS_LIKE_A_SENTENCE_RE = /[.!]\s*(FINAL KILL!)?$/;

const LEGACY_COLORS = ['black', 'dark_blue', 'dark_green', 'dark_aqua',
  'dark_red', 'dark_purple', 'gold', 'gray', 'dark_gray', 'blue',
  'green', 'aqua', 'red', 'light_purple', 'yellow', 'white'];

function textRuns(text, inheritedColor) {
  const runs = [];
  let color = inheritedColor;
  let offset = 0;
  for (const match of text.matchAll(/§([0-9a-fk-or])/gi)) {
    if (match.index > offset) runs.push({text: text.slice(offset, match.index), color});
    const code = match[1].toLowerCase();
    if (/[0-9a-f]/.test(code)) color = LEGACY_COLORS[parseInt(code, 16)];
    else if (code === 'r') color = null;
    offset = match.index + match[0].length;
  }
  if (offset < text.length) runs.push({text: text.slice(offset), color});
  return runs;
}

export function flattenComponent(component, inheritedColor = null) {
  if (component == null) return [];
  if (Array.isArray(component)) {
    // siblings inherit the first component style
    const color = component[0]?.color || inheritedColor;
    return component.flatMap(child => flattenComponent(child, color));
  }
  if (typeof component === "string") return textRuns(component, inheritedColor);
  const color = component.color || inheritedColor;
  const runs = component.text != null ? textRuns(String(component.text), color) : [];
  if (Array.isArray(component.extra)) {
    for (const child of component.extra) runs.push(...flattenComponent(child, color));
  }
  return runs;
}

export function flattenToText(component) {
  return flattenComponent(component)
    .map((run) => run.text)
    .join("");
}

function colorOf(runs, name) {
  const text = runs.map(run => run.text).join("");
  let index = text.indexOf(name);
  while (index !== -1) {
    const before = text[index - 1] || "";
    const after = text[index + name.length] || "";
    if (!/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)) {
      let offset = 0;
      for (const run of runs) {
        if (index < offset + run.text.length) return run.color;
        offset += run.text.length;
      }
    }
    index = text.indexOf(name, index + 1);
  }
  return null;
}

// only tab names may be truncated
export function resolveKnownPlayer(chatName, knownPlayers) {
  if (!chatName || !knownPlayers) return null;
  if (knownPlayers.has(chatName)) return chatName;

  let best = null;
  for (const known of knownPlayers) {
    if (!known || known.length < 3) continue;
    if (known.length >= chatName.length) continue;
    if (chatName.startsWith(known) && (!best || known.length > best.length)) {
      best = known;
    }
  }
  return best;
}

function extractByColor(text, runs, knownPlayers, resolveTeam) {
  if (!knownPlayers || knownPlayers.size === 0) return null;
  if (!resolveTeam) return null;
  if (!LOOKS_LIKE_A_SENTENCE_RE.test(text)) return null;

  const candidates = [];
  for (const run of runs) {
    const name = run.text.trim();
    if (!name || /\s/.test(name)) continue;
    if (!resolveTeam(run.color)) continue;
    if (!resolveKnownPlayer(name, knownPlayers)) continue;
    if (candidates[candidates.length - 1] !== name) candidates.push(name);
  }
  // join notices also color names
  if (candidates.length !== 2) return null;
  if (!text.startsWith(candidates[0] + " ") || /[:>]/.test(text)) return null;

  const victim = candidates[0];
  const killer = candidates.length > 1 ? candidates[candidates.length - 1] : null;
  if (killer === victim) return null;

  return {
    type: "death",
    victim,
    victimColor: colorOf(runs, victim),
    killer,
    killerColor: killer ? colorOf(runs, killer) : null,
    cause: killer ? "pvp" : "environmental",
    rawCause: "unrecognized wording (matched by color)",
    finalKill: /FINAL KILL!\s*$/.test(text),
    raw: text,
  };
}

export function parseMessage(component, knownPlayers, resolveTeam) {
  const runs = flattenComponent(component);
  const text = runs.map((r) => r.text).join("").trim();
  if (!text) return null;

  const eliminated=text.match(/^TEAM ELIMINATED > (Red|Blue|Green|Yellow|Aqua|White|Pink|Gr[ae]y) Team has been eliminated!$/i);
  if(eliminated)return {type:'team_eliminated',team:teamName(eliminated[1].toLowerCase()),raw:text};
  const bedMatch = text.match(BED_RE);
  if (bedMatch) {
    const [, teamColorWord, breaker] = bedMatch;
    return {
      type: "bed_break",
      team: teamName(teamColorWord.toLowerCase()) || teamColorWord.toLowerCase(),
      breaker,
      breakerColor: colorOf(runs, breaker),
      raw: text,
    };
  }

  const finalCounterMatch = text.match(FINAL_COUNTER_RE);
  if (finalCounterMatch) {
    const [, victim, killer] = finalCounterMatch;
    const killerIsPlayer = knownPlayers?.size ? Boolean(resolveKnownPlayer(killer, knownPlayers)) : true;
    return {
      type: "death",
      victim,
      victimColor: colorOf(runs, victim),
      killer: killerIsPlayer ? killer : null,
      killerColor: killerIsPlayer ? colorOf(runs, killer) : null,
      cause: killerIsPlayer ? "pvp" : "environmental",
      rawCause: "final kill",
      finalKill: true,
      raw: text,
    };
  }

  const killMatch = text.match(KILL_RE) || ALT_KILL_RES.map((re) => text.match(re)).find(Boolean);
  if (killMatch) {
    const [, victim, verbPhrase, killer, finalKillSuffix] = killMatch;
    const killerIsPlayer = knownPlayers?.size ? Boolean(resolveKnownPlayer(killer, knownPlayers)) : true;
    return {
      type: "death",
      victim,
      victimColor: colorOf(runs, victim),
      killer: killerIsPlayer ? killer : null,
      killerColor: killerIsPlayer ? colorOf(runs, killer) : null,
      cause: killerIsPlayer ? "pvp" : "environmental",
      rawCause: verbPhrase,
      finalKill: Boolean(finalKillSuffix),
      raw: text,
    };
  }

  const soloMatch = text.match(SOLO_DEATH_RE);
  if (soloMatch) {
    const [, victim, finalKillSuffix] = soloMatch;
    return {
      type: "death",
      victim,
      victimColor: colorOf(runs, victim),
      killer: null,
      killerColor: null,
      cause: "environmental",
      rawCause: text.includes("void") ? "fell into the void" : "died",
      finalKill: Boolean(finalKillSuffix),
      raw: text,
    };
  }

  const colorMatch = extractByColor(text, runs, knownPlayers, resolveTeam);
  if (colorMatch) return colorMatch;

  return null;
}
