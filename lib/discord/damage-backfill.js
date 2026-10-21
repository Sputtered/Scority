import {damageTracked} from '../stat-fields.js';

// preserve saved stats and edits
export function mergePlayerDamage(previous,scored) {
  if(!damageTracked(scored.tracking) || scored.match?.endReason!=='replay_finished')throw Error('A complete player-damage recording is required');
  if(!previous.match?.replayId || previous.match.replayId.toLowerCase()!==scored.match?.replayId?.toLowerCase() || previous.match.totalDurationSec!==scored.match.totalDurationSec)
    throw Error('Replay identity or duration mismatch');
  const names=Object.keys(previous.players).sort();
  if(JSON.stringify(names)!==JSON.stringify(Object.keys(scored.players).sort()))throw Error('Player roster mismatch');
  const close=(a,b)=>Math.abs(a-b)<.0001;
  let dealt=0,received=0;
  for(const name of names){
    const p=scored.players[name];
    if(p.team!==previous.players[name].team)throw Error('Player team mismatch');
    for(const value of [p.damageDealt,p.damageReceived])if(!Number.isFinite(value)||value<0)throw Error('Invalid damage total');
    if(!p.damageByOpponent || !close(p.damageDealt,Object.values(p.damageByOpponent).reduce((n,o)=>n+o.dealt,0)) ||
      !close(p.damageReceived,Object.values(p.damageByOpponent).reduce((n,o)=>n+o.received,0)))throw Error('Opponent totals do not match');
    for(const [other,o]of Object.entries(p.damageByOpponent)){
      const q=scored.players[other],reverse=q?.damageByOpponent?.[name];
      if(!q || !p.team || !q.team || p.team===q.team || !reverse || !close(o.dealt,reverse.received) || !close(o.received,reverse.dealt))throw Error('Opponent damage is not reciprocal');
    }
    dealt+=p.damageDealt;received+=p.damageReceived;
  }
  if(!close(dealt,received))throw Error('Dealt and received totals do not balance');
  const result=structuredClone(previous);
  for(const name of names)for(const field of ['damageDealt','damageReceived','damageByOpponent'])result.players[name][field]=structuredClone(scored.players[name][field]);
  result.tracking??={};result.tracking.damage=structuredClone(scored.tracking.damage);result.tracking.damageEvents=structuredClone(scored.tracking.damageEvents);
  return result;
}
