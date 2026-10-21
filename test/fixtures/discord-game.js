export function game({index=1,winner='red',aliceTeam='red',bobTeam='green',kills=2,deaths=1}={}) {
  const killFeed=[];
  for (let i=0;i<kills;i++) killFeed.push({t:index*100+i,victim:'Mikowa',killer:'Sputtered',finalKill:false});
  for (let i=0;i<deaths;i++) killFeed.push({t:index*100+20+i,victim:'Sputtered',killer:'Mikowa',finalKill:false});
  return {match:{winner,totalDurationSec:600,generatedAt:`2026-09-${String(index).padStart(2,'0')}T12:00:00Z`,endReason:'replay_finished'},
    players:{Sputtered:{team:aliceTeam,kills,deaths,finalKills:0,bedBreaks:1,longestStreak:kills},
      Mikowa:{team:bobTeam,kills:deaths,deaths:kills,finalKills:0,bedBreaks:0,longestStreak:deaths}},
    killFeed,bedBreaks:[{t:index,team:'green',breaker:'Sputtered'}],awards:{firstBlood:'Sputtered'},warnings:[]};
}
