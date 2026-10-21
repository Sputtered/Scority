import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {createGunzip} from 'node:zlib';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {DamageExperiment,damageText} from '../lib/damage-experiment.js';

const {values,positionals}=parseArgs({allowPositionals:true,options:{output:{type:'string',default:'captures/damage-trial'},game:{type:'string'}}});
if(!positionals.length)throw Error('node scripts/damage-trial.js <packets.jsonl.gz> [...] [--output directory] [--game G00001]');
fs.mkdirSync(values.output,{recursive:true});
for(const filename of positionals) {
  const source=fs.createReadStream(filename),unzip=createGunzip(),hash=createHash('sha256');
  source.on('data',chunk=>hash.update(chunk));source.on('error',err=>unzip.destroy(err));
  const lines=readline.createInterface({input:source.pipe(unzip),crlfDelay:Infinity});let experiment;
  for await(const line of lines){const row=JSON.parse(line);if(row.type==='capture')experiment=new DamageExperiment(row.version);experiment?.observe(row);}
  if(!experiment)throw Error('Missing capture header');
  const report=experiment.reportDamage();report.captureSha256=hash.digest('hex');report.gameLabel=values.game??null;
  const base=path.join(values.output,`${report.gameLabel??report.replayId}-${report.version}-${report.captureSha256.slice(0,8)}`);
  fs.writeFileSync(base+'.json',JSON.stringify(report,null,2));fs.writeFileSync(base+'.txt',damageText(report));
  console.log(JSON.stringify({report:base+'.json',totals:report.variants.isolated.totals,
    variants:Object.fromEntries(Object.entries(report.variants).map(([k,v])=>[k,{assigned:v.assignedEvents,events:v.eventsCount,coverage:v.damageCoverage}]))}));
}
