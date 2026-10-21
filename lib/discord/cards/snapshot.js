import {createHash} from 'node:crypto';
import {visibleStats} from '../../stat-fields.js';

export function gameSnapshot(game) {
  return {id:game.id,winner_reviewed:game.winner_reviewed,payload:{match:{voided:game.voided,winner:game.payload.match.winner,totalDurationSec:game.payload.match.totalDurationSec,...(game.payload.match.participatingTeams?{participatingTeams:game.payload.match.participatingTeams}:{})},
    players:Object.fromEntries(Object.entries(game.payload.players).map(([name,p])=>[name,visibleStats(p,game.payload.tracking)])),nameLinks:game.payload.nameLinks,teamUpgrades:game.payload.teamUpgrades,
    tracking:game.payload.tracking?{status:game.payload.tracking.status,damage:game.payload.tracking.damage,...(game.payload.tracking.assists?{assists:game.payload.tracking.assists}:{}),...(game.payload.tracking.voidedDiamonds?{voidedDiamonds:game.payload.tracking.voidedDiamonds}:{}),...(game.payload.tracking.itemUsage?{itemUsage:game.payload.tracking.itemUsage}:{})}:null}};
}

// bump to refresh cached cards
export function gameCardFingerprint(game,style='inventory') {
  return createHash('sha256').update(JSON.stringify({revision:4,style,data:gameSnapshot(game)})).digest('hex');
}
