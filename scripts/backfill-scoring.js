import fs from 'node:fs';
import {parseArgs} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {planScoringBackfill,applyScoringBackfill,summarizeScoringBackfill} from '../lib/discord/scoring-backfill.js';

const {values,positionals}=parseArgs({allowPositionals:true,options:{database:{type:'string'},backup:{type:'string'},apply:{type:'boolean',default:false}}});
if(!values.database||!fs.existsSync(values.database)||!positionals.length||(values.apply&&!values.backup))
  throw Error('Usage: backfill-scoring.js --database <existing.sqlite> [--apply --backup <new-backup.json>] <scored.json> [...]');
const db=new DatabaseSync(values.database,{readOnly:!values.apply});
try{
  db.exec('PRAGMA busy_timeout=5000');
  const inputs=positionals.map(file=>({file,scored:JSON.parse(fs.readFileSync(file,'utf8'))}));
  const updates=planScoringBackfill(db,inputs);
  if(values.apply)applyScoringBackfill(db,updates,{backup:values.backup});
  console.log(JSON.stringify({applied:values.apply,games:summarizeScoringBackfill(updates)},null,2));
}finally{db.close();}
