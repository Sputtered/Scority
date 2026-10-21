import {TEAM_NAMES} from '../../lib/team-colors.js';
export function publicGame({teams=TEAM_NAMES,size=2}={}){
  const players={};
  for(const team of teams)for(let n=0;n<size;n++)players[team+n]={team,kills:0,deaths:0,finalKills:0,bedBreaks:0,longestStreak:0,
    diamondsCollected:n+2,emeraldsCollected:n,damageDealt:0,damageReceived:0,damageByOpponent:{}};
  const winner=teams.includes('pink')?'pink':teams.includes('blue')?'blue':teams.at(-1);
  const p={match:{winner,totalDurationSec:600,generatedAt:'2026-09-26T23:00:00Z',participatingTeams:teams},players,
    killFeed:[],bedBreaks:[],warnings:[],tracking:{status:'tracked',damage:{version:1,status:'tracked',scope:'attributed-player-damage'},damageEvents:[]}};
  let seq=1;
  for(const team of teams.filter(t=>t!==winner))for(let n=0;n<size;n++){
    const victim=team+n,helper=winner+'1',killer=winner+'0',t=100+seq;
    p.tracking.damageEvents.push({sequence:seq++,t:t-1,lifeId:seq,victim,attacker:helper,healthLoss:4,method:'swing-and-aim'});
    p.killFeed.push({sequence:seq++,t,lifeId:seq-1,victim,killer,finalKill:true});
    players[victim].deaths++;players[killer].kills++;players[killer].finalKills++;
    players[helper].damageDealt+=4;players[victim].damageReceived+=4;
    players[helper].damageByOpponent[victim]={dealt:4,received:0};players[victim].damageByOpponent[helper]={dealt:0,received:4};
  }
  return p;
}
