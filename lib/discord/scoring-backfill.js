import fs from 'node:fs';
import {ReplayStore,ADMIN_ID} from './store.js';
import {mergePlayerDamage} from './damage-backfill.js';
import {PLAYER_DAMAGE_VERSION} from '../player-damage.js';

const resourceStats=['diamondsCollected','emeraldsCollected','diamondsVoided'];
const resourceDiagnostics=['resourceCarried','resourcePickups'];
const trackingFields=['version','status','protocolVersion','playbackSpeeds','issues','unresolvedCollections',
  'chunkErrors','decodeErrors','enderChests','resourceVersion','resourceRule','resourceEvents','voidedDiamonds','unresolvedResourceAmounts'];
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const close=(a,b)=>Math.abs(a-b)<.0001;
const fingerprint=payload=>ReplayStore.prototype._fingerprint(payload);
const editsFor=(db,id)=>db.prepare('SELECT payload FROM game_stat_edits WHERE game_id=?').get(id)?.payload??null;

// preserve unrelated stats and metadata
export function mergeScoring(previous,scored,{edits={}}={}) {
  if(scored.tracking?.damage?.version!==PLAYER_DAMAGE_VERSION)throw Error('Rescore with the current damage version before backfilling');
  const result=mergePlayerDamage(previous,scored),tracking=scored.tracking;
  if(tracking.status!=='tracked' || tracking.resourceVersion!==2 || tracking.voidedDiamonds?.version!==1 ||
      tracking.voidedDiamonds.status!=='tracked' || !Array.isArray(tracking.resourceEvents) || !Array.isArray(tracking.damageEvents))
    throw Error('Complete versioned resource and damage evidence is required');
  if(Object.entries(tracking.decodeErrors??{}).some(([name,count])=>name.startsWith('playing:')&&count>0))
    throw Error('Undecodable playback packets cannot be backfilled');
  const uncertain=tracking.unresolvedResourceAmounts??[];
  if(!Array.isArray(uncertain)||uncertain.some(resource=>!['diamond','emerald'].includes(resource)))
    throw Error('Invalid resource amount uncertainty');
  const damage=new Map(Object.keys(scored.players).map(name=>[name,{dealt:0,received:0}]));
  for(const event of tracking.damageEvents){
    if(!Number.isFinite(event.healthLoss)||event.healthLoss<0||!damage.has(event.victim))throw Error('Invalid damage evidence');
    if(event.attacker){
      if(!damage.has(event.attacker)||event.attacker===event.victim||scored.players[event.attacker].team===scored.players[event.victim].team)
        throw Error('Invalid damage attacker evidence');
      damage.get(event.attacker).dealt+=event.healthLoss;damage.get(event.victim).received+=event.healthLoss;
    }
  }
  const voids=new Map();
  for(const event of tracking.resourceEvents.filter(e=>e.kind==='void')){
    if(event.resource!=='diamond'||!Object.hasOwn(scored.players,event.player)||!integer(event.quantity)||event.quantity===0)
      throw Error('Invalid voided diamond evidence');
    voids.set(event.player,(voids.get(event.player)??0)+event.quantity);
  }
  const preservedManualStats=[];
  for(const [name,player] of Object.entries(scored.players)){
    if(!close(player.damageDealt,damage.get(name).dealt)||!close(player.damageReceived,damage.get(name).received))
      throw Error('Damage totals do not match their evidence');
    for(const pair of Object.values(player.damageByOpponent))for(const value of [pair.dealt,pair.received])
      if(!Number.isFinite(value)||value<0)throw Error('Invalid opponent damage');
    for(const stat of resourceStats){
      const value=player[stat];
      if(value!==null&&!integer(value))throw Error(`Invalid ${stat} for ${name}`);
      if(((stat==='diamondsCollected'&&uncertain.includes('diamond'))||(stat==='emeraldsCollected'&&uncertain.includes('emerald')))&&value!==null)
        throw Error('Unresolved resource quantities must stay unavailable');
      // missing evidence is not zero
      if(stat==='diamondsVoided'&&(value===null?voids.has(name):value!==(voids.get(name)??0)))
        throw Error('Voided diamond totals do not match their evidence');
      if(Object.hasOwn(edits.players?.[name]??{},stat)||previous.players[name].manualStats?.includes(stat)){
        preservedManualStats.push({player:name,stat});continue;
      }
      result.players[name][stat]=value;
    }
    for(const field of resourceDiagnostics){
      if(!player[field]||!['diamond','emerald'].every(resource=>integer(player[field][resource])))throw Error(`Invalid ${field} for ${name}`);
      result.players[name][field]=structuredClone(player[field]);
    }
  }
  for(const field of trackingFields)if(Object.hasOwn(tracking,field))result.tracking[field]=structuredClone(tracking[field]);
  return {payload:result,preservedManualStats};
}

export function planScoringBackfill(db,inputs) {
  const seen=new Set();
  return inputs.map(({scored,file=null})=>{
    const replayId=scored.match?.replayId;
    if(typeof replayId!=='string'||!replayId)throw Error('Scored input is missing its replay ID');
    const row=db.prepare('SELECT * FROM games WHERE replay_id=?').get(replayId);
    if(!row)throw Error('Saved game not found: '+replayId);
    if(seen.has(row.id))throw Error('Duplicate game in backfill');seen.add(row.id);
    const original=JSON.parse(row.payload),edits=editsFor(db,row.id);
    if(fingerprint(original)!==row.fingerprint)throw Error('Saved game fingerprint does not match its raw evidence');
    const merged=mergeScoring({...original,match:{...original.match,replayId:row.replay_id}},scored,{edits:JSON.parse(edits??'{}')});
    merged.payload.match=original.match;
    if(fingerprint(merged.payload)!==row.fingerprint)throw Error('Backfill changed the game fingerprint');
    return {row,edits,file,...merged};
  });
}

export function applyScoringBackfill(db,updates,{backup,actor=ADMIN_ID,now=new Date()}={}) {
  if(!backup)throw Error('Applying a backfill requires a new backup file');
  if(!updates.length)throw Error('No games to backfill');
  const createdAt=now.toISOString();
  fs.writeFileSync(backup,JSON.stringify({schema:1,kind:'scoring-backfill',createdAt,
    games:updates.map(u=>u.row),manualEdits:updates.map(u=>({gameId:u.row.id,payload:u.edits}))},null,2),{flag:'wx'});
  db.exec('BEGIN IMMEDIATE');
  try{
    for(const update of updates){
      const {row,payload,edits}=update,current=db.prepare('SELECT * FROM games WHERE id=?').get(row.id);
      if(JSON.stringify(current)!==JSON.stringify(row)||editsFor(db,row.id)!==edits)
        throw Error('Game changed during validation; retry from a new backup');
      if(fingerprint(payload)!==row.fingerprint)throw Error('Backfill changed the game fingerprint');
      db.prepare('UPDATE games SET payload=? WHERE id=?').run(JSON.stringify(payload),row.id);
      db.prepare('INSERT INTO audit(actor,action,detail,created_at) VALUES(?,?,?,?)').run(actor,'scoring_backfill',
        JSON.stringify({gameId:row.id,replayId:row.replay_id,damageVersion:payload.tracking.damage.version,
          resourceVersion:payload.tracking.resourceVersion,backup,preservedManualStats:update.preservedManualStats}),createdAt);
    }
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
}

export function summarizeScoringBackfill(updates) {
  return updates.map(({row,payload,preservedManualStats})=>({id:row.id,replayId:row.replay_id,
    damageVersion:payload.tracking.damage.version,resourceVersion:payload.tracking.resourceVersion,preservedManualStats,
    players:Object.fromEntries(Object.entries(payload.players).map(([name,p])=>[name,Object.fromEntries(
      ['damageDealt','damageReceived',...resourceStats].map(stat=>[stat,p[stat]]))]))}));
}
