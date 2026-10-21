import fs from 'node:fs';
import {parseArgs} from 'node:util';
import {ReplayStore,ADMIN_ID} from '../lib/discord/store.js';
import {mergePlayerDamage} from '../lib/discord/damage-backfill.js';
const {values,positionals}=parseArgs({allowPositionals:true,options:{database:{type:'string'},backup:{type:'string'},apply:{type:'boolean',default:false}}});
if(!values.database || !fs.existsSync(values.database) || !positionals.length || (values.apply&&!values.backup))throw Error('Usage: backfill-player-damage.js --database <existing.sqlite> [--apply --backup <new-backup.json>] <scored.json> [...]');
const store=new ReplayStore(values.database);
try{
  const updates=positionals.map(file=>{
    const scored=JSON.parse(fs.readFileSync(file,'utf8'));
    const row=store.db.prepare('SELECT * FROM games WHERE replay_id=?').get(scored.match.replayId);
    if(!row)throw Error('Saved game not found: '+scored.match.replayId);
    const original=JSON.parse(row.payload),payload=mergePlayerDamage({...original,match:{...original.match,replayId:row.replay_id}},scored);
    payload.match=original.match;
    if(store._fingerprint(payload)!==row.fingerprint)throw Error('Backfill changed the game fingerprint');
    return {row,payload};
  });
  if(new Set(updates.map(u=>u.row.id)).size!==updates.length)throw Error('Duplicate game in backfill');
  if(values.apply){
    fs.writeFileSync(values.backup,JSON.stringify(updates.map(u=>u.row),null,2),{flag:'wx'});
    store.transaction(()=>{
      for(const {row,payload}of updates){
        const current=store.db.prepare('SELECT payload FROM games WHERE id=?').get(row.id);
        if(current.payload!==row.payload)throw Error('Game changed during validation; retry from a new backup');
        store.db.prepare('UPDATE games SET payload=? WHERE id=?').run(JSON.stringify(payload),row.id);
        store.log(ADMIN_ID,'damage_backfill',{gameId:row.id,replayId:row.replay_id,version:payload.tracking.damage.version,backup:values.backup});
      }
    });
  }
  console.log(JSON.stringify({applied:values.apply,games:updates.map(u=>u.row.id)}));
}finally{store.close();}
