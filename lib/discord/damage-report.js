import {damageText} from '../damage-experiment.js';

export function damageMessage(report) {
  const text=damageText(report),s=report.variants[report.selectedVariant],f=n=>n.toFixed(0);
  const fields=Object.entries(s.players).sort((a,b)=>b[1].dealt-a[1].dealt).map(([player,p])=>({name:player,
    value:`**Dealt ${f(p.dealt)} | Received ${f(p.received)}**\n`+
      (Object.entries(p.opponents).sort((a,b)=>a[0].localeCompare(b[0])).map(([other,v])=>`${other}: dealt **${f(v.dealt)}**, received **${f(v.received)}**`).join('\n')||'No attributed opponent damage.')}));
  fields.push({name:'Totals',value:`Dealt **${f(s.totals.dealt)}** | Received **${f(s.totals.received)}**`});
  const embed={color:0xffd84d,title:`Experimental player damage · ${report.gameLabel??report.replayId}`,
    description:`${report.replayId} · ${Math.floor(report.durationSec/60)}:${String(report.durationSec%60).padStart(2,'0')} · ${report.speeds.join('/')}× playback\nHP (2 HP = 1 heart). Dealt and received count only damage attributed to another player. Unattributed health loss is excluded. Accuracy unmeasured; absorption and missing/fatal health updates may be incomplete.`,fields};
  if(fields.length>25 || fields.some(f=>f.value.length>1024) || embed.title.length+embed.description.length+fields.reduce((n,f)=>n+f.name.length+f.value.length,0)>5900)
    throw Error('Report exceeds Discord embed limits; review the text report');
  return {embeds:[embed],text,name:`damage-${report.gameLabel??report.replayId}-${report.captureSha256.slice(0,8)}.txt`};
}
