import {TEAM_COLORS} from './team-colors.js';
import { Match } from './match.js';
import { packetText, unwrapNbt } from './packet-capture.js';
import { parseActionBar } from './actionbar-parser.js';
import { parseMessage } from './death-parser.js';

export function createCaptureMatch(version,replayId) {
  return new Match({protocolVersion:version,teamColors:TEAM_COLORS,
    meta:{source:'packet-capture',replayId,protocolVersion:version}});
}
export function scorePacket(match,row) {
  if(row.type!=='packet')return;
  const {name,data}=row;
  const action=name==='action_bar' || (name==='chat' && data.position===2) || (name==='system_chat' && (data.isActionBar || data.overlay));
  if(action){const hud=parseActionBar(packetText(name,data));if(hud)match.updateActionBar(hud);}
  match.observePacket(name,data,row.state || 'play',row.sequence,row.receivedMs);
  if(['chat','system_chat'].includes(name) && !action) {
    let component=unwrapNbt(data.message ?? data.content ?? data.text);
    if(typeof component==='string'){try{component=JSON.parse(component);}catch{}}
    const event=parseMessage(component,match.knownOnlinePlayers.size?match.knownOnlinePlayers:null,match.resolveTeam);
    if(event)match.handleParsedMessage(event);
  }
}
