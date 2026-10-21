import {ProtectionExperiment} from './protection-estimator.js';

const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const same=(a,b)=>a?.entityId===b?.entityId && a?.generation===b?.generation &&
  (a?.lifeId===undefined || b?.lifeId===undefined || a.lifeId===b.lifeId);
const round=n=>Math.round(n*1e6)/1e6;
export const DAMAGE_ATTRIBUTION_VERSION=2;
export const DAMAGE_VARIANTS={
  strict:{range:3.6,isolated:false},
  latency:{range:4.5,isolated:false},
  isolated:{range:4.5,isolated:true},
};

// range and padding are hypotheses
export function aimedAt(attacker,victim,range=4.5) {
  if(!attacker.position || !victim.position || !Number.isFinite(attacker.yaw) || !Number.isFinite(attacker.pitch))return false;
  const yaw=attacker.yaw*Math.PI/180,pitch=attacker.pitch*Math.PI/180;
  const direction={x:-Math.sin(yaw)*Math.cos(pitch),y:-Math.sin(pitch),z:Math.cos(yaw)*Math.cos(pitch)};
  const origin={...attacker.position,y:attacker.position.y+1.62};
  const low={x:victim.position.x-.65,y:victim.position.y-.35,z:victim.position.z-.65};
  const high={x:victim.position.x+.65,y:victim.position.y+2.15,z:victim.position.z+.65};
  let near=0,far=range+1;
  for(const axis of ['x','y','z']) {
    if(Math.abs(direction[axis])<1e-8){if(origin[axis]<low[axis] || origin[axis]>high[axis])return false;continue;}
    const a=(low[axis]-origin[axis])/direction[axis],b=(high[axis]-origin[axis])/direction[axis];
    near=Math.max(near,Math.min(a,b));far=Math.min(far,Math.max(a,b));
    if(near>far)return false;
  }
  return true;
}

export class DamageExperiment extends ProtectionExperiment {
  constructor(version){super(version);this.issues=new Set();this.firstPlaying=null;this.previousHud=null;this.lastHud=null;this.rawErrors=0;this.observedNames=new Set();}
  actor(id) {
    const p=super.actor(id),e=this.world.entities.get(id);
    return p?{...p,pitch:e.pitch,health:e.health}:null;
  }
  observe(row) {
    if(row.type==='packet' && row.replay) {
      const h=row.replay,previous=this.previousHud;
      if(h.state==='playing') {
        this.firstPlaying??=h.elapsedSec;
        if(previous && (previous.epoch!==h.epoch || h.elapsedSec<previous.elapsedSec ||
          h.elapsedSec-previous.elapsedSec>Math.max(1,h.speed,previous.speed)*2 || h.totalSec!==previous.totalSec))this.issues.add('Replay navigation detected');
        if(['login','respawn'].includes(row.name))this.issues.add('World changed during playback');
        if(row.name==='capture_unparsed')this.rawErrors++;
      }
      this.previousHud=h;this.lastHud=h;
    }
    const signalCount=this.signals.length;
    super.observe(row);
    // use positions from before knockback
    for(const signal of this.signals.slice(signalCount))if(signal.kind==='hurt')
      signal.roster=[...this.world.entities.keys()].map(id=>this.actor(id)).filter(Boolean);
    if(row.type==='packet' && row.replay?.state==='playing')for(const e of this.world.entities.values()) {
      if(e.kind==='player'){const name=this.world.playerName(e);if(name)this.observedNames.add(name);}
    }
  }
  attribute({range=4.5,isolated=true,replayMsWindow=600}={}) {
    const replayMs=(a,b)=>Math.abs(a.receivedMs-b.receivedMs)*Math.max(a.speed,b.speed);
    const close=(a,b)=>a.epoch===b.epoch &&
      Math.abs(a.t-b.t)<=Math.max(1,a.speed,b.speed) && Number.isFinite(a.receivedMs) && Number.isFinite(b.receivedMs) &&
      replayMs(a,b)<=replayMsWindow;
    // arrival time precedes packet order
    const nearest=(reference,after)=>(a,b)=>replayMs(a,reference)-replayMs(b,reference) ||
      Number(after?a.sequence<reference.sequence:a.sequence>reference.sequence)-
        Number(after?b.sequence<reference.sequence:b.sequence>reference.sequence) ||
      Math.abs(a.sequence-reference.sequence)-Math.abs(b.sequence-reference.sequence);
    const losses=this.health.filter(h=>h.healthLoss>0),hurts=this.signals.filter(s=>s.kind==='hurt');
    const hurtMatches=new Map(),usedSwings=new Set();
    for(const hurt of hurts) {
      const match=losses.filter(h=>same(h.victim,hurt.actor)&&close(h,hurt))
        .sort(nearest(hurt,true))[0];
      if(match){const matches=hurtMatches.get(match.sequence)??[];matches.push(hurt);hurtMatches.set(match.sequence,matches);}
    }
    return losses.map(h=>{
      const matchedHurts=hurtMatches.get(h.sequence)??[];
      const event={sequence:h.sequence,t:h.t,victim:h.victim.name,healthLoss:h.healthLoss,attacker:null,method:'unassigned',
        reason:null,candidates:[],hurtSequences:matchedHurts.map(x=>x.sequence)};
      if(matchedHurts.length!==1){event.reason=matchedHurts.length?'multiple-hurt-events':'no-hurt-event';return event;}
      const hurt=matchedHurts[0],v=hurt.actor;
      if((h.victim.flags&1)||(v.flags&1)){event.reason='burning';return event;}
      if(!v.team){event.reason='unknown-team';return event;}
      const roster=(hurt.roster??h.roster).filter(p=>!same(p,v) && p.position && v.position && p.health!==0 &&
        (!v.team || !p.team || v.team!==p.team));
      const nearby=roster.filter(p=>distance(p.position,v.position)<=range);
      for(const p of roster) {
        if(!p.team || p.team===v.team)continue;
        const swing=this.signals.filter(s=>s.kind==='swing' && same(s.actor,p) && close(s,h) && close(s,hurt) &&
          !usedSwings.has(s.sequence) && s.actor.position && distance(s.actor.position,v.position)<=range && aimedAt(s.actor,v,range))
          .sort(nearest(hurt,false))[0];
        const aim=nearby.includes(p)&&aimedAt(p,v,range),evidence=swing?.actor??p;
        if(swing || (isolated && nearby.length===1 && aim))event.candidates.push({name:p.name,distance:round(distance(evidence.position,v.position)),
          yaw:evidence.yaw,pitch:evidence.pitch,swingSequence:swing?.sequence??null,method:swing?'swing-and-aim':'isolated-and-aim',
          hurtSequence:hurt.sequence,attackerPosition:{...evidence.position},victimPosition:{...v.position}});
      }
      if(event.candidates.length===1 && !nearby.some(p=>!p.team)) {
        const c=event.candidates[0];event.attacker=c.name;event.method=c.method;
        if(c.swingSequence!==null)usedSwings.add(c.swingSequence);
      } else event.reason=event.candidates.length>1?'multiple-attackers':nearby.some(p=>!p.team)?'unknown-nearby-team':'no-supported-attacker';
      return event;
    });
  }
  reportDamage() {
    if(!this.ended || this.endReason!=='Replay finished')throw Error('Damage report requires a finished replay capture');
    if(this.firstPlaying===null || this.firstPlaying>Math.max(1,this.lastHud?.speed??1))this.issues.add('Capture did not start at the beginning');
    if(!this.lastHud || this.lastHud.totalSec<=0 || this.lastHud.totalSec>=1200)throw Error('Damage trials require a replay under 20 minutes');
    if(this.lastHud.state!=='finished' || this.lastHud.elapsedSec<this.lastHud.totalSec)this.issues.add('Missing final replay HUD');
    if(this.issues.size)throw Error([...this.issues].join('; '));
    const variants=Object.fromEntries(Object.entries(DAMAGE_VARIANTS).map(([name,options])=>{
      const events=this.attribute(options);return [name,{options,...summarizeDamage(events,[...this.observedNames]),events}];
    }));
    return {experiment:'damage-v2',attributionVersion:DAMAGE_ATTRIBUTION_VERSION,receivedScope:'attributed-player-damage',replayId:this.header?.replayId,version:this.version,durationSec:this.lastHud.totalSec,
      speeds:[...new Set(this.health.map(h=>h.speed))],accuracy:null,decodeErrors:this.rawErrors,
      note:'Experimental player damage in HP (2 HP = 1 heart). Dealt and received count only health loss attributed to another player. Observed and unassigned health loss are diagnostic fields; unassigned does not mean environmental. Missing health updates, fatal hits, absorption, projectiles and simultaneous healing can be incomplete. No independently labeled accuracy. Distance allowance is not measured ping.',
      selectedVariant:'isolated',variants};
  }
}

export function summarizeDamage(events,names=[]) {
  const players=Object.create(null),get=name=>players[name]??=( {dealt:0,received:0,observedHealthLoss:0,unassignedHealthLoss:0,opponents:Object.create(null)} );
  names.forEach(get);
  const pair=(p,name)=>p.opponents[name]??={dealt:0,received:0};
  let assignedEvents=0;
  for(const e of events) {
    const v=get(e.victim);v.observedHealthLoss+=e.healthLoss;
    if(e.attacker){const a=get(e.attacker);a.dealt+=e.healthLoss;v.received+=e.healthLoss;
      pair(a,e.victim).dealt+=e.healthLoss;pair(v,e.attacker).received+=e.healthLoss;assignedEvents++;
    } else v.unassignedHealthLoss+=e.healthLoss;
  }
  const totals=Object.values(players).reduce((s,p)=>({dealt:s.dealt+p.dealt,received:s.received+p.received,
    observedHealthLoss:s.observedHealthLoss+p.observedHealthLoss,unassignedHealthLoss:s.unassignedHealthLoss+p.unassignedHealthLoss}),
    {dealt:0,received:0,observedHealthLoss:0,unassignedHealthLoss:0});
  for(const p of Object.values(players))for(const key of ['dealt','received','observedHealthLoss','unassignedHealthLoss'])p[key]=round(p[key]);
  for(const p of Object.values(players))for(const o of Object.values(p.opponents)){o.dealt=round(o.dealt);o.received=round(o.received);}
  for(const k of Object.keys(totals))totals[k]=round(totals[k]);
  return {players,totals,eventsCount:events.length,assignedEvents,eventCoverage:events.length?assignedEvents/events.length:0,
    damageCoverage:totals.observedHealthLoss?totals.dealt/totals.observedHealthLoss:0};
}

export function damageText(report) {
  if(report.experiment!=='damage-v2' || report.receivedScope!=='attributed-player-damage')throw Error('Regenerate this report: received damage must count attributed player damage only');
  const r=report.variants[report.selectedVariant],f=n=>n.toFixed(0);
  const lines=[`Experimental damage | ${report.gameLabel??report.replayId} | ${Math.floor(report.durationSec/60)}:${String(report.durationSec%60).padStart(2,'0')}`,
    'HP (2 HP = 1 heart). Dealt and received count only damage attributed to another player.',
    'Unattributed health loss is excluded. Accuracy unmeasured; attribution is inferred. Absorption and missing/fatal health updates may be incomplete.',
    `Replay: ${report.replayId}`,`Capture: ${report.version}, ${report.speeds.join('/')}x; undecodable playback packets: ${report.decodeErrors}`,''];
  for(const [name,p]of Object.entries(r.players).sort((a,b)=>b[1].dealt-a[1].dealt)) {
    lines.push(`${name}: dealt ${f(p.dealt)} | received ${f(p.received)}`);
    for(const [other,o]of Object.entries(p.opponents).sort((a,b)=>a[0].localeCompare(b[0])))lines.push(`  vs ${other}: dealt ${f(o.dealt)} | received ${f(o.received)}`);
  }
  lines.push('',`TOTAL: dealt ${f(r.totals.dealt)} | received ${f(r.totals.received)}`);
  return lines.join('\n');
}
