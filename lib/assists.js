import {teamKnown,teamName} from './team-colors.js';
import {damageTracked} from './stat-fields.js';

export const ASSIST_RULE={version:1,minDamage:2,windowSeconds:10};
const key=name=>String(name??'').toLowerCase();

export function applyAssists(payload) {
  if(!damageTracked(payload.tracking) || !Array.isArray(payload.tracking.damageEvents))return payload;
  const roster=new Map(Object.entries(payload.players).map(([name,p])=>[key(name),{name,team:teamName(p.team)}]));
  const totals=new Map([...roster.keys()].map(name=>[name,{assists:0,assistsByOpponent:Object.create(null)}]));
  const seenHits=new Set();
  const events=payload.tracking.damageEvents.filter(e=>{
    if(!Number.isFinite(e.t) || !Number.isFinite(e.healthLoss) || e.healthLoss<=0 || !e.attacker || String(e.method).startsWith('credited-void'))return false;
    const id=e.sequence!=null?`${key(e.victim)}:${e.lifeId}:${e.sequence}`:null;
    if(id && seenHits.has(id))return false;if(id)seenHits.add(id);return true;
  });
  const byVictim=new Map();for(const e of events){const name=key(e.victim);if(!byVictim.has(name))byVictim.set(name,[]);byVictim.get(name).push(e);}
  const deaths=[...(payload.killFeed || [])].filter(e=>Number.isFinite(e.t)).sort((a,b)=>a.t-b.t || (a.sequence??Infinity)-(b.sequence??Infinity));
  const previous=new Map(),seen=new Set(),awards=[];
  for(const death of deaths){
    const victim=roster.get(key(death.victim)),killer=roster.get(key(death.killer));
    const identity=death.lifeId!=null?`${key(death.victim)}:life:${death.lifeId}`:`${key(death.victim)}:${death.t}:${death.sequence??''}:${key(death.killer)}`;
    if(seen.has(identity))continue;seen.add(identity);
    const last=previous.get(key(death.victim));previous.set(key(death.victim),death);
    if(!victim || !killer || !teamKnown(victim.team) || !teamKnown(killer.team) || victim.team===killer.team)continue;
    let hits=(byVictim.get(key(death.victim)) || []).filter(e=>e.t>=death.t-ASSIST_RULE.windowSeconds && e.t<=death.t &&
      (death.sequence==null || e.sequence==null || e.sequence<=death.sequence) &&
      (last==null || (last.sequence!=null && e.sequence!=null ? e.sequence>last.sequence : e.t>last.t)));
    // legacy audits use the latest observed life
    const life=death.lifeId??hits.toSorted((a,b)=>(b.sequence??b.t)-(a.sequence??a.t))[0]?.lifeId;
    if(life!=null)hits=hits.filter(e=>e.lifeId===life);
    const contributions=new Map();
    for(const hit of hits){
      const helper=roster.get(key(hit.attacker));
      if(!helper || helper.name===killer.name || helper.team!==killer.team)continue;
      contributions.set(helper.name,(contributions.get(helper.name)||0)+hit.healthLoss);
    }
    for(const [helper,damage]of contributions)if(damage+1e-6>=ASSIST_RULE.minDamage){
      const p=totals.get(key(helper));p.assists++;
      p.assistsByOpponent[victim.name]=(p.assistsByOpponent[victim.name]||0)+1;
      awards.push({t:death.t,sequence:death.sequence??null,lifeId:life??null,helper,victim:victim.name,killer:killer.name,damage});
    }
  }
  for(const [name,p]of Object.entries(payload.players))Object.assign(p,totals.get(key(name)));
  payload.tracking.assists={...ASSIST_RULE,status:'tracked',scope:'teammate-kill-assists'};
  payload.tracking.assistEvents=awards;
  return payload;
}
