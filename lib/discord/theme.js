import {teamKnown,teamLabel} from '../team-colors.js';
export const YELLOW = 0xffd84d;
export const NICK_REMINDER = 'Try not to use nicks/alts. Use your main.';
export const winLossText = (wins,losses) => `${wins} ${wins===1?'win':'wins'} · ${losses} ${losses===1?'loss':'losses'}`;
export const resultText = winner => teamKnown(winner)?`${teamLabel(winner)} team wins`:'Result pending';
export const statusName = status => ({queued:'Waiting',recording:'Scoring now',completed:'Done',failed:'Could not finish',invalid:'Invalid replay',cancelled:'Cancelled'}[status] || 'Unknown');
export const metricName = metric => ({kd:'K/D ratio',wl:'W/L ratio',submissions:'Replays submitted'}[metric] || 'K/D ratio');
export function issueText(reason) {
  if (/180 seconds/.test(reason)) return `${reason} This replay was skipped and still uses a daily spot.`;
  if (/Couldn't find a replay by that UUID!/i.test(reason)) return 'I couldn’t find this replay on Hypixel, so I marked it invalid and removed it from the queue. Check the replay ID and submit a new one. This still uses a daily spot.';
  if (/whitelist|access removed/i.test(reason)) return 'This replay was removed because the user is no longer whitelisted.';
  if (/restarted|queued again/i.test(reason)) return 'The bot restarted. Your replay is back in the queue.';
  if (/disconnect|connection|socket/i.test(reason)) return 'The game connection was lost. Ask me to try again.';
  if (/HUD|load|open.*replay|viewable/i.test(reason)) return 'We could not open this replay. Check the ID or ask me.';
  if (/timed out|too long/i.test(reason)) return 'This replay took too long to finish. Ask me to try again.';
  if (/empty|no usable|no game/i.test(reason)) return 'We could not find a game to score in this replay.';
  return 'We could not finish this replay. Ask me to try again.';
}
