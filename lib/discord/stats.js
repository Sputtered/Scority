import {teamKnown} from '../team-colors.js';
import { ign, UserError } from './store.js';
import { EXTENDED_STATS,DAMAGE_STATS,ITEM_STATS,damageTracked,assistsTracked,voidedDiamondsTracked,itemUsageTracked,visibleStats } from '../stat-fields.js';
const key = name => String(name || '').toLowerCase();
const number = value => Number.isFinite(value) && value >= 0 ? value : 0;
export const ratio = (total, against) => Math.round(number(total) / Math.max(1,number(against)) * 100) / 100;
export const displayRatio = n => number(n).toFixed(2);
export const countsForStats = game => !game.voided && !game.payload.match.voided && !game.payload.nameLinks?.excludedFromStats;
export function participant(game, name) {
  const pair = Object.entries(game.payload.players).find(([player])=>key(player)===key(name));
  return pair ? {name:pair[0],...pair[1]} : null;
}
export function playerNames(games) {
  const names = new Map();
  for (const game of games.filter(countsForStats)) for (const name of Object.keys(game.payload.players)) names.set(key(name),name);
  return [...names.values()].sort((a,b)=>a.localeCompare(b));
}
export function playerGames(games, name) { return games.filter(g=>participant(g,name)); }
export function gameMatchups(game, input) {
  if (game.voided || game.payload.match.voided) throw new UserError('This game was voided and does not count toward stats.');
  if (!countsForStats(game)) throw new UserError('I need to fix this game’s name links before showing matchups.');
  const name=ign(input);
  // resolve original names within this game
  const linked=game.payload.nameLinks?.assignments.find(entry=>key(entry.original)===key(name));
  const rawPlayer=participant(game,linked?.main || name);
  const player=rawPlayer?visibleStats(rawPlayer,game.payload.tracking):null;
  if (!player) throw new UserError('That player is no longer listed in this game. Choose another player.');
  if (!teamKnown(player.team)) throw new UserError('This player’s team was not recorded. We cannot tell who their opponents were.');
  const opponents=Object.entries(game.payload.players).filter(([,p])=>teamKnown(p.team) && p.team!==player.team)
    .map(([name,p])=>({name,team:p.team,kills:0,deaths:0,kd:0,
      assists:assistsTracked(game.payload.tracking)?player.assistsByOpponent?.[name]??0:null,
      damageDealt:damageTracked(game.payload.tracking)?player.damageByOpponent?.[name]?.dealt??0:null,
      damageReceived:damageTracked(game.payload.tracking)?player.damageByOpponent?.[name]?.received??0:null}));
  const byName=new Map(opponents.map(p=>[key(p.name),p]));
  for (const event of game.payload.killFeed) {
    if (key(event.killer)===key(player.name)) {
      const opponent=byName.get(key(event.victim)); if (opponent) opponent.kills++;
    }
    if (key(event.victim)===key(player.name)) {
      const opponent=byName.get(key(event.killer)); if (opponent) opponent.deaths++;
    }
  }
  for (const opponent of opponents) opponent.kd=ratio(opponent.kills,opponent.deaths);
  opponents.sort((a,b)=>b.kills-a.kills || a.deaths-b.deaths || a.name.localeCompare(b.name));
  const kills=opponents.reduce((sum,p)=>sum+p.kills,0),deaths=opponents.reduce((sum,p)=>sum+p.deaths,0);
  return {gameId:game.id,name:player.name,team:player.team,opponents,kills,deaths,kd:ratio(kills,deaths),
    gameTotals:{kills:player.kills,deaths:player.deaths},
    assists:assistsTracked(game.payload.tracking)?player.assists??0:null,
    finalKills:player.finalKills,bedBreaks:player.bedBreaks,diamondsCollected:player.diamondsCollected,emeraldsCollected:player.emeraldsCollected,diamondsVoided:player.diamondsVoided??null,
    damageDealt:player.damageDealt??null,damageReceived:player.damageReceived??null,
    ...Object.fromEntries(ITEM_STATS.map(stat=>[stat,player[stat]??null])),
    unassignedCount:Object.values(game.payload.players).filter(p=>!teamKnown(p.team)).length};
}
export function playerStats(games, input) {
  const name = ign(input);
  const result = {name,games:0,wins:0,losses:0,unknown:0,kills:0,deaths:0,finalKills:0,bedBreaks:0,longestStreak:0,history:[]};
  result.newStatsGames=Object.fromEntries(EXTENDED_STATS.map(stat=>[stat,0]));
  for(const stat of EXTENDED_STATS)result[stat]=0;
  for (const game of games) {
    if (!countsForStats(game)) continue;
    const p = participant(game,name); if (!p) continue;
    result.name = p.name; result.games++;
    for (const stat of ['kills','deaths','finalKills','bedBreaks']) result[stat] += number(p[stat]);
    for(const stat of EXTENDED_STATS)if((stat!=='assists'||assistsTracked(game.payload.tracking)) && (stat!=='diamondsVoided'||voidedDiamondsTracked(game.payload.tracking)||p.manualStats?.includes(stat)) && (!DAMAGE_STATS.includes(stat)||damageTracked(game.payload.tracking)) && (!ITEM_STATS.includes(stat)||itemUsageTracked(game.payload.tracking)) && (game.payload.tracking?.status!=='invalid'||p.manualStats?.includes(stat)) && Number.isFinite(p[stat]) && p[stat]>=0){result[stat]+=p[stat];result.newStatsGames[stat]++;}
    result.longestStreak = Math.max(result.longestStreak,number(p.longestStreak));
    const winner = game.payload.match.winner;
    const outcome = teamKnown(p.team) && teamKnown(winner) ? (winner===p.team?'win':'loss') : 'unknown';
    result[outcome==='win'?'wins':outcome==='loss'?'losses':'unknown']++;
    result.history.push({game,outcome});
  }
  result.kd=ratio(result.kills,result.deaths);
  result.wl=ratio(result.wins,result.losses);
  result.winrate=result.wins+result.losses ? Math.round(result.wins/(result.wins+result.losses)*1000)/10 : 0;
  for(const stat of EXTENDED_STATS)result[stat]=result.newStatsGames[stat]?Math.round(result[stat]*10000)/10000:null;
  return result;
}
export function matchup(games, inputA, inputB) {
  const a = ign(inputA), b = ign(inputB);
  if (key(a)===key(b)) throw new UserError('Choose two different Minecraft players.');
  const result = {a,b,games:0,wins:0,losses:0,unknown:0,kills:0,deaths:0,teammateGames:0,unassignedGames:0,history:[]};
  for (const game of games) {
    if (!countsForStats(game)) continue;
    const p=participant(game,a), q=participant(game,b); if (!p || !q) continue;
    result.a=p.name; result.b=q.name;
    if (!teamKnown(p.team) || !teamKnown(q.team)) { result.unassignedGames++; continue; }
    if (p.team===q.team) { result.teammateGames++; continue; }
    result.games++;
    const winner=game.payload.match.winner;
    const outcome = teamKnown(winner) ? winner===p.team?'win':'loss' : 'unknown';
    result[outcome==='win'?'wins':outcome==='loss'?'losses':'unknown']++;
    let kills=0,deaths=0;
    for (const event of game.payload.killFeed) {
      if (key(event.killer)===key(a) && key(event.victim)===key(b)) kills++;
      if (key(event.killer)===key(b) && key(event.victim)===key(a)) deaths++;
    }
    result.kills+=kills; result.deaths+=deaths;
    result.history.push({game,outcome,kills,deaths});
  }
  result.kd=ratio(result.kills,result.deaths);
  return result;
}
export function teammates(games,input) {
  const name=ign(input), rows=new Map();
  for (const game of games) {
    if (!countsForStats(game)) continue;
    const p=participant(game,name); if (!p || !teamKnown(p.team)) continue;
    for (const [other,q] of Object.entries(game.payload.players)) {
      if (key(other)===key(name) || q.team!==p.team) continue;
      const row=rows.get(key(other)) || {name:other,games:0,wins:0,losses:0,unknown:0};
      row.games++;
      const winner=game.payload.match.winner;
      row[!teamKnown(winner)?'unknown':winner===p.team?'wins':'losses']++;
      rows.set(key(other),row);
    }
  }
  return [...rows.values()].sort((a,b)=>b.games-a.games || b.wins-a.wins || a.name.localeCompare(b.name));
}
export function rivals(games,input) {
  const name=ign(input);
  return playerNames(games).filter(n=>key(n)!==key(name)).map(n=>matchup(games,name,n))
    .filter(r=>r.games).sort((a,b)=>b.games-a.games || b.kills-a.kills || a.b.localeCompare(b.b));
}
export function leaderboard(games, metric='kd', minimum=1) {
  if (!['kd','wl'].includes(metric)) throw new UserError('Choose K/D ratio, W/L ratio, or replays submitted in /leaderboard.');
  return playerNames(games).map(n=>playerStats(games,n)).filter(p=>p.games>=minimum)
    .sort((a,b)=>b[metric]-a[metric] || b.games-a.games || a.name.localeCompare(b.name)).slice(0,10);
}
