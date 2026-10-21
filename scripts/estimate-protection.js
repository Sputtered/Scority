import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {createGunzip} from 'node:zlib';
import {createHash} from 'node:crypto';
import {ProtectionExperiment} from '../lib/protection-estimator.js';

const args=process.argv.slice(2),files=[];let reviewFrom=0,reportDir='captures/protection-estimate';
for(let i=0;i<args.length;i++){
  if(args[i]==='--review-from')reviewFrom=Number(args[++i]);
  else if(args[i]==='--report-dir')reportDir=args[++i];
  else if(args[i].startsWith('--'))throw Error('Unknown option: '+args[i]);
  else files.push(args[i]);
}
if(!Number.isFinite(reviewFrom)||reviewFrom<0||!reportDir)throw Error('Invalid report options');
if(!files.length){console.error('node scripts/estimate-protection.js <packets.jsonl.gz> [...] [--review-from seconds] [--report-dir directory]');process.exit(1);}
const reports=[];
for(const filename of files){
  const hash=createHash('sha256'),source=fs.createReadStream(filename),unzip=createGunzip();
  source.on('data',chunk=>hash.update(chunk));source.on('error',error=>unzip.destroy(error));
  const lines=readline.createInterface({input:source.pipe(unzip),crlfDelay:Infinity});
  let experiment;
  for await(const line of lines){const row=JSON.parse(line);if(row.type==='capture')experiment=new ProtectionExperiment(row.version);experiment?.observe(row);}
  if(!experiment?.ended)throw Error('A complete capture is required');
  const report=experiment.report();report.captureSha256=hash.digest('hex');
  if(report.captureEndReason!=='Replay finished')throw Error('Capture did not finish the replay');
  report.source=path.resolve(filename);
  reports.push(report);
  const output=path.join(path.dirname(filename),'protection-experiment.json');
  fs.writeFileSync(output,JSON.stringify(report,null,2));
  console.log(JSON.stringify({output,version:report.version,speeds:report.speeds,lossEvents:report.lossEvents,
    selected:report.selected.length,rejected:report.rejected.length,rejectionReasons:report.rejectionReasons,
    windows:report.windows.length,byPlayer:Object.fromEntries([...new Set(report.selected.map(h=>h.victim))].map(n=>[n,report.selected.filter(h=>h.victim===n).length])),
    fits:report.windows.map(w=>({victim:w.victim,from:w.from,to:w.to,models:w.fits.map(f=>({model:f.model,status:f.status,levels:f.compatibleLevels}))}))},null,2));
}

const clock=t=>`${Math.floor(t/60)}:${String(t%60).padStart(2,'0')}`;
const levels=f=>f.compatibleLevels.length?f.compatibleLevels.slice().sort().map(n=>['0','I','II','III','IV'][n]).join(' / '):'No fit';
const rows=['# Protection estimate experiment','',
  'These are model-compatible candidates, not verified upgrades. No known Protection labels were supplied; measured accuracy is unavailable.',
  'Both captures contain the same replay. Their agreement is a repeatability check, not an independent accuracy test.','',
  '| Capture | Health drops | Selected hits | Excluded | Complete ten-hit windows | Vanilla model compatible hits | Linear model compatible hits |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: |'];
for(const r of reports){
  const counts=[0,1].map(i=>r.individualFits.filter(h=>h.fits[i].compatibleLevels.length).length);
  rows.push(`| ${r.version}, ${r.speeds.join('/')}x | ${r.lossEvents} | ${r.selected.length} | ${r.rejected.length} | ${r.windows.length} | ${counts[0]}/${r.selected.length} | ${counts[1]}/${r.selected.length} |`);
}
rows.push('','Model-compatible counts are **not accuracy percentages**. Selection is based on packets and geometry, never on whether a damage model fits.',
  'The vanilla model includes random enchantment damage reduction. The linear model is an alternative hypothesis and is not assumed to describe Hypixel.',
  'A Protection level is assumed equal across the worn armor pieces. Sharpness 0 and I are both tried; uncertain critical hits try both possibilities.','');
for(const r of reports){
  const bySeq=new Map(r.individualFits.map(x=>[x.sequence,x]));
  rows.push(`## ${r.version}: ten individual hits from ${clock(reviewFrom)}`,'',
    'The first ten selected events after this time are shown, in packet order. They involve multiple players; they are not ten hits proving one player\'s level.','',
    '| Replay time | Defender | Inferred attacker | Sword | Health lost | Vanilla candidate levels | Linear candidate levels | Packet |',
    '| --- | --- | --- | --- | ---: | --- | --- | ---: |');
  for(const h of r.selected.filter(h=>h.t>=reviewFrom).slice(0,10)){
    const f=bySeq.get(h.sequence).fits;
    rows.push(`| ${clock(h.t)} | ${h.victim} | ${h.attacker} | ${h.sword.replace('_sword','')} | ${h.healthLoss.toFixed(4)} | ${levels(f[0])} | ${levels(f[1])} | ${h.sequence} |`);
  }
  rows.push('','### All selected events','',
    '| Time | Defender | Attacker | Health lost | Vanilla candidates | Packet |','| --- | --- | --- | ---: | --- | ---: |');
  for(const h of r.selected)rows.push(`| ${clock(h.t)} | ${h.victim} | ${h.attacker} | ${h.healthLoss.toFixed(4)} | ${levels(bySeq.get(h.sequence).fits[0])} | ${h.sequence} |`);
  rows.push('','### Exclusion reasons','',...Object.entries(r.rejectionReasons).sort((a,b)=>b[1]-a[1]).map(([reason,n])=>`- ${reason}: ${n}`),
    '',`Capture SHA-256: ${r.captureSha256}`,'');
}
const comparisons=[];
if(reports.length===2&&reports[0].replayId===reports[1].replayId){
  const [a,b]=reports,used=new Set();
  const af=new Map(a.individualFits.map(f=>[f.sequence,f])),bf=new Map(b.individualFits.map(f=>[f.sequence,f]));
  for(const h of a.selected){
    const matches=b.selected.filter(j=>!used.has(j.sequence)&&h.victim===j.victim&&h.attacker===j.attacker&&h.sword===j.sword&&
      JSON.stringify(h.armor)===JSON.stringify(j.armor)&&Math.abs(h.t-j.t)<=2&&
      Math.abs(h.healthBefore-j.healthBefore)<.002&&Math.abs(h.healthAfter-j.healthAfter)<.002);
    if(matches.length!==1)continue;const other=matches[0];used.add(other.sequence);
    const left=af.get(h.sequence).fits[0].compatibleLevels,right=bf.get(other.sequence).fits[0].compatibleLevels;
    comparisons.push({victim:h.victim,t:h.t,sequences:[h.sequence,other.sequence],levels:[left,right],
      identicalCandidates:JSON.stringify([...left].sort())===JSON.stringify([...right].sort())});
  }
  rows.push('## Repeatability','',`${comparisons.length} selected events could be matched uniquely by player, attacker, equipment, health before/after, and replay time. `+
    `${comparisons.filter(p=>p.identicalCandidates).length} had identical vanilla-model candidate sets.`,
    'This does not verify the attacker attribution or the actual Protection level.','');
}
rows.push('## Limits and next validation','',
  '- Exact server-side combat rules are not independently known. A good fit is conditional on the model.',
  '- Attacker assignment is inferred. Critical/effect/absorption metadata may be incomplete.',
  '- Ten consecutive selected hits must fit within 120 seconds of one player\'s unchanged armor-appearance segment to emit a formal conditional estimate.',
  '- A hidden Protection upgrade can happen without an appearance change. Incompatible segments must not be forced to one level.',
  '- Healing, absorption, blocking, deaths and nearby equipment changes exclude hits when observed. Remaining unexplained damage is kept as No fit.',
  '- Next validation requires a known-level Hypixel replay or controlled hits, followed by separate held-out hits.',
  '- No live scores, cards, queue jobs or database records were changed.','',
  '## Reference implementation','',
  '- [1.8 Protection factor](https://github.com/Attano/Spigot-1.8/blob/master/net/minecraft/server/v1_8_R3/EnchantmentProtection.java)',
  '- [Randomized protection factor](https://github.com/Attano/Spigot-1.8/blob/master/net/minecraft/server/v1_8_R3/EnchantmentManager.java)',
  '- [Critical hits and enchantment damage](https://github.com/Attano/Spigot-1.8/blob/master/net/minecraft/server/v1_8_R3/EntityHuman.java)',
  '- [Damage modifiers and absorption](https://github.com/Attano/Spigot-1.8/blob/master/net/minecraft/server/v1_8_R3/EntityLiving.java)','');
fs.mkdirSync(reportDir,{recursive:true});
fs.writeFileSync(path.join(reportDir,'report.md'),rows.join('\n'));
fs.writeFileSync(path.join(reportDir,'comparison.json'),JSON.stringify({reviewFrom,accuracy:null,comparisons},null,2));
console.log('Readable report: '+path.resolve(reportDir,'report.md'));
