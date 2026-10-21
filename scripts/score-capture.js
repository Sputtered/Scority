import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createGunzip } from 'node:zlib';
import { createCaptureMatch, scorePacket } from '../lib/capture-scoring.js';
const filename=process.argv[2];
if(!filename){console.log('node scripts/score-capture.js <packets.jsonl.gz> [output.json]');process.exit(1);}
const source=fs.createReadStream(filename),unzip=createGunzip();
source.on('error',error=>unzip.destroy(error));
const lines=readline.createInterface({input:source.pipe(unzip),crlfDelay:Infinity});
let match,ended=false;
for await(const line of lines){
  const row=JSON.parse(line);
  if(row.type==='capture')match=createCaptureMatch(row.version,row.replayId);
  else if(row.type==='end')ended=true;
  else if(match)scorePacket(match,row);
}
if(!match || !ended || match.replayState!=='finished')throw new Error('A complete capture ending at the finished replay HUD is required.');
const payload=match.toJSON();payload.match.endReason='replay_finished';
const output=process.argv[3] || path.join(path.dirname(filename),'scored.json');
fs.writeFileSync(output,JSON.stringify(payload,null,2));
console.log(JSON.stringify({output,winner:payload.match.winner,players:payload.players,
  tracking:{...payload.tracking,resourceEvents:payload.tracking.resourceEvents.length}},null,2));
