const HEX_FALLBACKS = {
  red: "#FF5555",
  dark_red: "#AA0000",
  green: "#55FF55",
  dark_green: "#00AA00",
  aqua: "#55FFFF",
  dark_aqua: "#00AAAA",
  blue: "#5555FF", dark_blue: "#0000AA", yellow: "#FFFF55", gold: "#FFAA00",
  white: "#FFFFFF", light_purple: "#FF55FF", dark_purple: "#AA00AA",
  gray: "#AAAAAA", dark_gray: "#555555",
};

export const TEAM_COLORS = {
  red: ['red', 'dark_red'], blue: ['blue', 'dark_blue'], green: ['green', 'dark_green'],
  yellow: ['yellow', 'gold'], aqua: ['aqua', 'dark_aqua'], white: ['white'],
  pink: ['light_purple', 'dark_purple', 'pink'], grey: ['gray', 'dark_gray', 'grey'],
};
export const TEAM_NAMES = Object.keys(TEAM_COLORS);
export const teamKnown = team => TEAM_NAMES.includes(team);
export const teamLabel = team => teamKnown(team) ? team[0].toUpperCase() + team.slice(1) : 'Team not recorded';
export const TEAM_INK = {red:'#ff9393',blue:'#929bff',green:'#a9ef9a',yellow:'#ffea7c',aqua:'#7ff2f2',white:'#f5f5f5',pink:'#ff9ae0',grey:'#b7bec7'};
export const TEAM_WOOL = {red:'red',blue:'blue',green:'lime',yellow:'yellow',aqua:'cyan',white:'white',pink:'pink',grey:'gray'};
export const legacyTeamColor = value => ({1:'dark_blue',2:'dark_green',3:'dark_aqua',4:'dark_red',5:'dark_purple',6:'gold',7:'gray',8:'dark_gray',9:'blue',a:'green',b:'aqua',c:'red',d:'light_purple',e:'yellow',f:'white'})[value] ?? null;
export const teamName = value => TEAM_NAMES.find(team => team===value || TEAM_COLORS[team].includes(legacyTeamColor(value) || value)) ?? null;

// legacy recordings default to two teams
export function gameTeams(payload) {
  const roster = Object.values(payload.players || {}).map(p => teamName(p.team)).filter(Boolean);
  const colors = new Set([...roster,teamName(payload.match?.winner),...(payload.match?.participatingTeams || []).map(teamName)]);
  if(!roster.length)for(const e of payload.bedBreaks || [])colors.add(teamName(e.team));
  const teams=TEAM_NAMES.filter(team=>colors.has(team));
  if(teams.length>=2)return teams;
  if(teams.length===1 && !['red','green','aqua'].includes(teams[0]))return teams;
  return ['red',colors.has('aqua')?'aqua':'green'];
}

function hexDistance(a, b) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const dr = ((pa >> 16) & 0xff) - ((pb >> 16) & 0xff);
  const dg = ((pa >> 8) & 0xff) - ((pb >> 8) & 0xff);
  const db = (pa & 0xff) - (pb & 0xff);
  return dr * dr + dg * dg + db * db;
}

export function makeTeamResolver(teamColorsConfig = TEAM_COLORS) {
  const lookup = new Map();
  for (const [team, colorNames] of Object.entries({...TEAM_COLORS,...teamColorsConfig})) {
    for (const name of colorNames) lookup.set(name, team);
  }

  return function resolveTeam(colorValue) {
    if (!colorValue) return null;
    if (lookup.has(colorValue)) return lookup.get(colorValue);

    if (colorValue.startsWith("#")) {
      let bestTeam = null;
      let bestDist = Infinity;
      for (const [name, hex] of Object.entries(HEX_FALLBACKS)) {
        if (!lookup.has(name)) continue;
        const dist = hexDistance(colorValue, hex);
        if (dist < bestDist) {
          bestDist = dist;
          bestTeam = lookup.get(name) || null;
        }
      }
      return bestTeam;
    }

    return null;
  };
}
