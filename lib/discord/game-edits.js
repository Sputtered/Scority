import {applyAssists} from '../assists.js';
import {TEAM_NAMES,teamKnown} from '../team-colors.js';
import {createHash} from 'node:crypto';
import {UserError,ign} from './store.js';
import {DAMAGE_STATS,visibleStats} from '../stat-fields.js';

export const EDIT_STATS=['kills','deaths','finalKills','bedBreaks','longestStreak','diamondsCollected','emeraldsCollected','diamondsVoided'];
const nullableStat=key=>key.endsWith('Collected')||key==='diamondsVoided';
export const EDIT_UPGRADES=['sharpness','protection1','protection2','protection3','protection4'];
export function initGameEdits(db){
  db.exec(`CREATE TABLE IF NOT EXISTS game_stat_edits(game_id INTEGER PRIMARY KEY REFERENCES games(id), payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS game_admin_history(id INTEGER PRIMARY KEY,game_id INTEGER NOT NULL REFERENCES games(id),
      actor TEXT NOT NULL,created_at TEXT NOT NULL,before_state TEXT NOT NULL,after_state TEXT NOT NULL);`);
}
export function statEdits(store,id){return JSON.parse(store.db.prepare('SELECT payload FROM game_stat_edits WHERE game_id=?').get(id)?.payload || '{}');}
export function applyGameEdits(payload,edits){
  for(const [name,stats]of Object.entries(edits.players || {}))if(Object.hasOwn(payload.players,name)){
    Object.assign(payload.players[name],stats);
    payload.players[name].manualStats=Object.keys(stats);
  }
  Object.assign(payload.match,edits.match || {});
  if(edits.upgrades){
    payload.teamUpgrades ||= {teams:{}};payload.teamUpgrades.teams ||= {};
    for(const [team,values]of Object.entries(edits.upgrades))Object.assign(payload.teamUpgrades.teams[team] ||= {},values);
  }
  for(const field of ['killFeed','bedBreaks'])if(Object.hasOwn(edits,field))payload[field]=structuredClone(edits[field]);
  return payload;
}
function state(store,id){
  const row=store.db.prepare('SELECT winner_reviewed,winner_override,review_reason FROM games WHERE id=?').get(id);
  return {edits:statEdits(store,id),names:store.gameNames(id),winner:row,
    void:store.db.prepare('SELECT * FROM game_voids WHERE game_id=?').get(id) || null};
}
export function editVersion(store,id){
  const row=store.db.prepare('SELECT payload FROM games WHERE id=?').get(id);
  return createHash('sha256').update(JSON.stringify([row?.payload,state(store,id),store.nameLinks()])).digest('hex');
}
function checkedRow(store,id){const row=store.db.prepare('SELECT * FROM games WHERE id=?').get(id);if(!row)throw new UserError('Game not found.');return row;}
export function gameEditor(store,id){
  const row=checkedRow(store,id),raw=applyAssists(applyGameEdits(JSON.parse(row.payload),statEdits(store,id))),game=store.getGame(id);
  const assignments=new Map(game.payload.nameLinks.assignments.map(n=>[n.original,n.main]));
  return {game,version:editVersion(store,id),draft:{
    winner:game.payload.match.winner || 'unknown',duration:raw.match.totalDurationSec,
    note:row.review_reason || '',voided:game.voided,voidReason:game.void_reason || '',
    players:Object.entries(raw.players).map(([original,p])=>({original,name:assignments.get(original)||original,team:p.team || '',
      ...Object.fromEntries(EDIT_STATS.map(key=>[key,visibleStats(p,raw.tracking)[key]??(nullableStat(key)?null:0)])),
      ...Object.fromEntries(['assists',...DAMAGE_STATS].map(key=>[key,visibleStats(p,raw.tracking)[key]??null]))})),
    upgrades:Object.fromEntries(TEAM_NAMES.map(team=>[team,Object.fromEntries(EDIT_UPGRADES.map(key=>{
      const value=raw.teamUpgrades?.teams?.[team]?.[key];return [key,value?.status==='estimated'?value.bySec:null];
    }))])),killFeed:raw.killFeed,bedBreaks:raw.bedBreaks,
  },history:store.db.prepare('SELECT id,actor,created_at FROM game_admin_history WHERE game_id=? ORDER BY id DESC LIMIT 20').all(id)};
}
function integer(value,label,{nullable=false,max=1000000}={}){
  if(nullable && value===null)return null;
  if(!Number.isInteger(value)||value<0||value>max)throw new UserError(`${label} must be a whole number between 0 and ${max}.`);
  return value;
}
function text(value,label,max=200){if(typeof value!=='string'||value.length>max)throw new UserError(`${label} is too long.`);return value.trim();}
function events(value,field,names,duration){
  if(!Array.isArray(value)||value.length>10000)throw new UserError('Invalid event list.');
  return value.map(event=>{
    if(!event || typeof event!=='object'||!Number.isFinite(event.t)||event.t<0||event.t>duration)throw new UserError('Event times must be within the game.');
    for(const key of field==='killFeed'?['killer','victim']:['breaker']){
      if(event[key]!=null && (!names.has(event[key])))throw new UserError(`Event ${key} must use an original player name.`);
    }
    if(field==='killFeed' && (typeof event.victim!=='string'||typeof event.finalKill!=='boolean'))throw new UserError('Each kill needs a victim and finalKill flag.');
    if(field==='bedBreaks' && !teamKnown(event.team))throw new UserError('Bed events need a supported team.');
    return event;
  });
}
function archive(store,id,actor,before){
  store.db.prepare('INSERT INTO game_admin_history(game_id,actor,created_at,before_state,after_state) VALUES(?,?,?,?,?)')
    .run(id,actor,store.now().toISOString(),JSON.stringify(before),JSON.stringify(state(store,id)));
}
function requireVersion(store,id,version){if(typeof version!=='string'||version!==editVersion(store,id))throw new UserError('This game changed while you were editing. Reload it before saving.');}
export function saveGameEditor(store,actor,id,version,draft){
  store.requireAdmin(actor);
  return store.transaction(()=>{
    const row=checkedRow(store,id);requireVersion(store,id,version);
    if(!draft||!Array.isArray(draft.players))throw new UserError('Invalid scoreboard.');
    const base=JSON.parse(row.payload),before=state(store,id),current=store.getGame(id),patch={players:Object.create(null)},names=new Set(Object.keys(base.players));
    if(draft.players.length!==names.size || new Set(draft.players.map(p=>p.original)).size!==names.size || draft.players.some(p=>!names.has(p.original)))throw new UserError('The player list changed. Reload this game.');
    integer(draft.duration,'Duration',{max:86400});if(draft.duration<180)throw new UserError('Duration must be at least 180 seconds.');
    if(![...TEAM_NAMES,'unknown'].includes(draft.winner)||typeof draft.voided!=='boolean')throw new UserError('Choose a valid result.');
    const note=text(draft.note,'Note'),voidReason=text(draft.voidReason,'Void reason');
    for(const p of draft.players){
      const values={},source=base.players[p.original];
      if(![...TEAM_NAMES,''].includes(p.team))throw new UserError('Choose a supported team or unassigned.');
      if((source.team||'')!==p.team)values.team=p.team||null;
      for(const key of EDIT_STATS){
        const val=integer(p[key],key,{nullable:nullableStat(key)});
        const baseline=key==='diamondsVoided'?visibleStats(source,base.tracking)[key]:source[key];
        if(val!==(baseline??(nullableStat(key)?null:0)))values[key]=val;
      }
      if(p.finalKills>p.kills)throw new UserError('Final kills cannot exceed kills.');
      if(Object.keys(values).length)patch.players[p.original]=values;
      const main=ign(p.name),existing=current.payload.nameLinks.assignments.find(n=>n.original===p.original)?.main;
      if(main!==existing)store.db.prepare('INSERT INTO game_names VALUES(?,?,?) ON CONFLICT(game_id,original) DO UPDATE SET main=excluded.main').run(id,p.original,main);
    }
    if(draft.duration!==base.match.totalDurationSec)patch.match={totalDurationSec:draft.duration};
    patch.upgrades={};
    for(const team of TEAM_NAMES){
      patch.upgrades[team]={};
      for(const key of EDIT_UPGRADES){
        const val=integer(draft.upgrades?.[team]?.[key]??null,`${team} ${key}`,{nullable:true,max:draft.duration});
        const old=base.teamUpgrades?.teams?.[team]?.[key];
        if(val!==(old?.status==='estimated'?old.bySec:null))patch.upgrades[team][key]=val===null?{status:'unavailable',bySec:null,manual:true}:{status:'estimated',bySec:val,manual:true};
      }
    }
    for(const team of TEAM_NAMES)if(!Object.keys(patch.upgrades[team]).length)delete patch.upgrades[team];
    // preserve unedited event evidence
    for(const field of ['killFeed','bedBreaks'])if(JSON.stringify(draft[field])!==JSON.stringify(base[field]))patch[field]=events(draft[field],field,names,draft.duration);
    store.db.prepare('INSERT INTO game_stat_edits VALUES(?,?) ON CONFLICT(game_id) DO UPDATE SET payload=excluded.payload').run(id,JSON.stringify(patch));
    if(draft.winner!==(current.payload.match.winner||'unknown'))store.db.prepare('UPDATE games SET winner_reviewed=1,winner_override=? WHERE id=?').run(draft.winner==='unknown'?null:draft.winner,id);
    store.db.prepare('UPDATE games SET review_reason=? WHERE id=?').run(note||null,id);
    if(draft.voided)store.db.prepare('INSERT INTO game_voids VALUES(?,?,?,?) ON CONFLICT(game_id) DO UPDATE SET reason=excluded.reason,actor=excluded.actor,voided_at=excluded.voided_at').run(id,voidReason||'Voided in admin panel.',actor,store.now().toISOString());
    else store.db.prepare('DELETE FROM game_voids WHERE game_id=?').run(id);
    store.assertNoNewNameConflicts([current],[store.getGame(id)]);
    archive(store,id,actor,before);store.log(actor,'webedit',{id});return gameEditor(store,id);
  });
}
export function restoreGameEditor(store,actor,id,version,historyId){
  store.requireAdmin(actor);
  return store.transaction(()=>{
    checkedRow(store,id);requireVersion(store,id,version);
    const revision=store.db.prepare('SELECT * FROM game_admin_history WHERE id=? AND game_id=?').get(historyId,id);
    if(!revision)throw new UserError('Edit not found.');
    const before=state(store,id),target=JSON.parse(revision.before_state),current=store.getGame(id);
    const raw=JSON.parse(store.db.prepare('SELECT payload FROM games WHERE id=?').get(id).payload);
    if(Object.keys(target.edits.players||{}).some(n=>!Object.hasOwn(raw.players,n)))throw new UserError('The recorded players have changed; edit the current scoreboard instead.');
    store.db.prepare('INSERT INTO game_stat_edits VALUES(?,?) ON CONFLICT(game_id) DO UPDATE SET payload=excluded.payload').run(id,JSON.stringify(target.edits));
    store.db.prepare('DELETE FROM game_names WHERE game_id=?').run(id);
    for(const n of target.names)store.db.prepare('INSERT INTO game_names VALUES(?,?,?)').run(id,n.original,n.main);
    store.db.prepare('UPDATE games SET winner_reviewed=?,winner_override=?,review_reason=? WHERE id=?').run(target.winner.winner_reviewed,target.winner.winner_override,target.winner.review_reason,id);
    store.db.prepare('DELETE FROM game_voids WHERE game_id=?').run(id);
    if(target.void)store.db.prepare('INSERT INTO game_voids VALUES(?,?,?,?)').run(id,target.void.reason,target.void.actor,target.void.voided_at);
    store.assertNoNewNameConflicts([current],[store.getGame(id)]);
    archive(store,id,actor,before);store.log(actor,'webrestore',{id,history:historyId});return gameEditor(store,id);
  });
}
