import {teamName} from './team-colors.js';
import {CaptureAnalysis} from './capture-analysis.js';
import {unwrapNbt} from './packet-capture.js';

const ARMOR={leather:[1,3,2,1],chainmail:[2,5,4,1],iron:[2,6,5,2],golden:[2,5,3,1],diamond:[3,8,6,3]};
const PARTS=['helmet','chestplate','leggings','boots'];
export const SWORDS={wooden_sword:5,golden_sword:5,stone_sword:6,iron_sword:7,diamond_sword:8};
export const MODELS=['vanilla-1.8','linear-4pct'];
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
const round=n=>Math.round(n*1e6)/1e6;
const histogram=values=>values.reduce((out,k)=>(out[k]=(out[k]||0)+1,out),{});

export function armorPoints(armor) {
  if(!Array.isArray(armor)||armor.length!==4)return null;
  let points=0;
  for(let i=0;i<4;i++){
    if(armor[i]===null)continue;
    if(typeof armor[i]!=='string' || !armor[i].endsWith('_'+PARTS[i]))return null;
    const material=armor[i].slice(0,-PARTS[i].length-1);
    if(!ARMOR[material])return null;
    points+=ARMOR[material][i];
  }
  return points;
}

// hypotheses, not confirmed server formulas
export function predictedLosses({sword,armor,protection,sharpness=0,critical=false,model='vanilla-1.8'}) {
  const points=armorPoints(armor),base=SWORDS[sword];
  if(points===null || !base || !Number.isInteger(protection) || protection<0 || protection>4 ||
      ![0,1].includes(sharpness) || !MODELS.includes(model))throw new Error('Unsupported damage hypothesis');
  const raw=base*(critical?1.5:1)+sharpness*1.25;
  const armored=raw*(1-points*.04),pieces=armor.filter(Boolean).length;
  if(model==='linear-4pct')return [round(armored*(1-Math.min(20,protection*pieces)*.04))];
  const epf=protection?Math.min(25,Math.floor((6+protection**2)/4)*pieces):0;
  const low=(epf+1)>>1,high=low+(epf>>1);
  return [...new Set(Array.from({length:high-low+1},(_,i)=>round(armored*(1-Math.min(20,low+i)*.04))))];
}

export function fitProtection(hits,{model='vanilla-1.8',tolerance=.002}={}) {
  const candidates=[];
  for(let protection=0;protection<=4;protection++){
    const fits=hits.map(hit=>{
      const alternatives=[];
      for(const sharpness of hit.sharpnessOptions??[0,1])for(const critical of hit.criticalOptions??[false,true]){
        for(const expected of predictedLosses({sword:hit.sword,armor:hit.armor,protection,sharpness,critical,model})){
          alternatives.push({expected,sharpness,critical,error:Math.abs(expected-hit.healthLoss)});
        }
      }
      alternatives.sort((a,b)=>a.error-b.error);
      return {sequence:hit.sequence,...alternatives[0]};
    });
    candidates.push({protection,matchingHits:fits.filter(f=>f.error<=tolerance).length,
      meanAbsoluteError:hits.length?round(fits.reduce((n,f)=>n+f.error,0)/hits.length):null,fits});
  }
  candidates.sort((a,b)=>b.matchingHits-a.matchingHits || a.meanAbsoluteError-b.meanAbsoluteError || a.protection-b.protection);
  const compatible=hits.length?candidates.filter(c=>c.matchingHits===hits.length).map(c=>c.protection):[];
  return {model,hits:hits.length,tolerance,compatibleLevels:compatible,
    status:hits.length<10?'insufficient-hits':compatible.length===1?'conditional-estimate':compatible.length>1?'ambiguous':'model-mismatch',
    estimatedLevel:hits.length>=10&&compatible.length===1?compatible[0]:null,candidates};
}

function compactItem(item,registry){
  if(!item || item.blockId===-1 || item.itemCount===0)return {name:null,enchanted:false};
  const nbt=unwrapNbt(item.nbtData??{});
  const enchantments=nbt.ench??item.components?.find(c=>c.type==='enchantments')?.data?.enchantments??[];
  return {name:registry.items[item.itemId??item.blockId]?.name??'unknown',enchanted:enchantments.length>0};
}

// animations identify targets; keep unexplained hits
export class ProtectionExperiment {
  constructor(version){
    this.world=new CaptureAnalysis(version);this.version=version;
    this.health=[];this.signals=[];this.equipmentChanges=[];this.armorChanges=[];
    this.armorState=new Map();this.phase=0;this.lastRow=null;this.header=null;this.ended=false;this.teamOverrides=new Map();
  }
  setPlayerTeam(name,team){if(name && teamName(team))this.teamOverrides.set(name.toLowerCase(),teamName(team));}
  stamp(row){return {sequence:row.sequence,t:row.replay?.elapsedSec??null,epoch:row.replay?.epoch??null,
    receivedMs:row.receivedMs,speed:row.replay?.speed??1};}
  actor(id){
    const e=this.world.entities.get(id);if(e?.kind!=='player')return null;
    const name=this.world.playerName(e);if(!name)return null;
    const prefix=this.world.teams.get(this.world.playerTeams.get(this.world.names.get(e.uuid)))?.prefix??'';
    const color=[...prefix.matchAll(/\u00a7([a-f0-9])/gi)].at(-1)?.[1]?.toLowerCase()??null;
    const team=teamName(color);
    const gear=e.experimentGear??{};
    const armor=PARTS.map(p=>gear[p]?.name);
    const signature=JSON.stringify(PARTS.map(p=>gear[p]??null));
    if(armorPoints(armor)!==null && this.armorState.get(name)?.signature!==signature){
      const phase=++this.phase;this.armorState.set(name,{signature,phase});
      this.armorChanges.push({...this.stamp(this.lastRow),player:name,armor,enchanted:PARTS.map(p=>gear[p]?.enchanted),phase});
    }
    return {name,entityId:id,generation:e.generation,team:this.teamOverrides.get(name.toLowerCase())??team,
      position:e.position?{...e.position}:null,yaw:e.yaw,armor,armorSignature:signature,
      armorPhase:this.armorState.get(name)?.phase??null,weapon:gear.hand??null,
      flags:e.experimentFlags??null,usingItem:e.experimentUsing??null,
      absorption:e.experimentAbsorption??null,
      effects:[...(e.experimentEffects??new Map()).values()].filter(f=>f.until>=(this.lastRow.replay?.elapsedSec??0))};
  }
  observe(row){
    if(row.type==='capture'){this.header=row;return;}
    if(row.type==='end'){this.ended=true;this.endReason=row.reason;return;}
    if(row.type!=='packet')return;
    this.lastRow=row;const {name,data}=row,w=this.world,playing=row.replay?.state==='playing';
    const stamp=this.stamp(row);
    const relevant=/^(player_info|player_list|teams$|scoreboard_team$|spawn_entity$|named_entity_spawn$|entity_metadata$|entity_destroy$|login$|respawn$|chat$|system_chat$|rel_entity_move$|entity_move_look$|entity_look$|entity_teleport$|sync_entity_position$)/;
    const oldEntity=w.entities.get(data.entityId),previousAbsorption=oldEntity?.experimentAbsorption;
    const count=w.healthChanges.length;
    if(relevant.test(name))w.observe(row);
    const entity=w.entities.get(data.entityId);
    if(entity?.kind==='player'){
      if(name==='entity_equipment'){
        entity.experimentGear??={};
        const entries=w.legacy?[{slot:data.slot,item:data.item}]:data.equipments??[];
        for(const {slot,item} of entries){
          const part=(w.legacy?['hand','boots','leggings','chestplate','helmet']:['hand','offhand','boots','leggings','chestplate','helmet'])[slot];
          if(!part)continue;
          const value=compactItem(item,w.registry),previous=entity.experimentGear[part];
          entity.experimentGear[part]=value;
          if(JSON.stringify(previous)!==JSON.stringify(value))this.equipmentChanges.push({...stamp,generation:entity.generation,entityId:data.entityId,part});
        }
      }
      for(const field of (name==='entity_metadata'||name==='named_entity_spawn'?data.metadata??[]:[])){
        if(field.key===0){entity.experimentFlags=field.value;if(w.legacy)entity.experimentUsing=Boolean(field.value&16);}
        if(!w.legacy&&field.key===8)entity.experimentUsing=Boolean(field.value&1);
        if(field.key===17&&typeof field.value==='number')entity.experimentAbsorption=field.value;
      }
      if(name==='entity_effect'){
        entity.experimentEffects??=new Map();
        entity.experimentEffects.set(data.effectId,{name:w.registry.effects[data.effectId]?.name??String(data.effectId),
          amplifier:data.amplifier,until:(stamp.t??0)+data.duration/20});
      }
      if(name==='remove_entity_effect')entity.experimentEffects?.delete(data.effectId);
    }
    if(!playing)return;
    const actor=this.actor(data.entityId);
    if(actor&&(name==='animation'||name==='hurt_animation'||(name==='entity_status'&&data.entityStatus===2))){
      const kind=name==='animation'?({0:'swing',4:'critical',5:'enchanted-hit'})[data.animation]:'hurt';
      if(kind)this.signals.push({...stamp,kind,actor});
    }
    for(const change of w.healthChanges.slice(count)){
      const victim=this.actor(change.entityId);if(!victim)continue;
      this.health.push({...stamp,...change,victim,previousAbsorption:previousAbsorption??null,
        roster:[...w.entities.keys()].map(id=>this.actor(id)).filter(Boolean)});
    }
  }
  select({sequenceWindow=100,replayMsWindow=350,range=3.6}={}){
    const close=(a,b,ms=replayMsWindow)=>a.epoch===b.epoch && Math.abs(a.sequence-b.sequence)<=sequenceWindow &&
      Math.abs(a.t-b.t)<=Math.max(1,a.speed,b.speed) &&
      Math.abs(a.receivedMs-b.receivedMs)*Math.max(a.speed,b.speed)<=ms;
    const same=(a,b)=>a.generation===b.generation&&a.entityId===b.entityId;
    const losses=this.health.filter(h=>h.healthLoss>0);
    const hurts=this.signals.filter(s=>s.kind==='hurt');
    const assigned=new Map();
    for(const hurt of hurts){
      const match=losses.filter(h=>same(h.victim,hurt.actor)&&close(h,hurt)).sort((a,b)=>Math.abs(a.sequence-hurt.sequence)-Math.abs(b.sequence-hurt.sequence))[0];
      if(match){if(!assigned.has(match.sequence))assigned.set(match.sequence,[]);assigned.get(match.sequence).push(hurt);}
    }
    const selected=[],rejected=[];
    for(const h of losses){
      const reasons=[];const v=h.victim,hurt=assigned.get(h.sequence)??[];
      if(hurt.length!==1)reasons.push(hurt.length?'multiple-hurt-events':'no-matching-hurt');
      if(h.health<=0)reasons.push('lethal-health-censored');
      if(armorPoints(v.armor)===null)reasons.push('unknown-armor');
      if(v.absorption===null||h.previousAbsorption===null)reasons.push('unknown-absorption');
      else if(v.absorption>0||h.previousAbsorption>0)reasons.push('absorption');
      if(v.flags===null||v.usingItem===null)reasons.push('unknown-player-flags');
      if((v.flags&1)||hurt.some(s=>s.actor.flags&1))reasons.push('burning');
      if(v.usingItem||hurt.some(s=>s.actor.usingItem))reasons.push('using-item-or-blocking');
      if(hurt.some(s=>s.actor.absorption>0)&&!reasons.includes('absorption'))reasons.push('absorption');
      if(v.effects.some(e=>/Resistance|Regeneration/.test(e.name)))reasons.push('defender-effect');
      if(this.health.some(o=>o!==h&&same(o.victim,v)&&close(o,h,500)))reasons.push('nearby-health-change');
      const near=h.roster.filter(p=>p.name!==v.name&&p.position&&v.position&&distance(p.position,v.position)<=range&&
        (!p.team||!v.team||p.team!==v.team));
      if(near.length!==1)reasons.push(near.length?'multiple-nearby-opponents':'no-nearby-opponent');
      const attacker=near.length===1?near[0]:null;
      const swings=attacker?this.signals.filter(s=>s.kind==='swing'&&same(s.actor,attacker)&&close(s,h)):[];
      if(attacker){
        if(!attacker.team||!v.team)reasons.push('unknown-team');
        if(!swings.length)reasons.push('no-matching-swing');
        if(!SWORDS[attacker.weapon?.name])reasons.push('unknown-or-nonsword-weapon');
        if(attacker.effects.some(e=>/Strength|Weakness/.test(e.name)))reasons.push('attacker-effect');
        const dx=v.position.x-attacker.position.x,dz=v.position.z-attacker.position.z,len=Math.hypot(dx,dz),yaw=attacker.yaw*Math.PI/180;
        const facing=len<.5?1:(-Math.sin(yaw)*dx+Math.cos(yaw)*dz)/len;
        if(attacker.yaw===null||facing<.5)reasons.push('attacker-not-facing');
        if(this.equipmentChanges.some(e=>same({generation:e.generation,entityId:e.entityId},attacker)&&e.part==='hand'&&close(e,h)))reasons.push('weapon-changing');
      }
      if(this.equipmentChanges.some(e=>same({generation:e.generation,entityId:e.entityId},v)&&PARTS.includes(e.part)&&close(e,h)))reasons.push('armor-changing');
      const critical=this.signals.filter(s=>s.kind==='critical'&&same(s.actor,v)&&hurt.length===1&&close(s,hurt[0],100));
      const magic=this.signals.filter(s=>s.kind==='enchanted-hit'&&same(s.actor,v)&&hurt.length===1&&close(s,hurt[0],100));
      const hit={sequence:h.sequence,t:h.t,epoch:h.epoch,resolution:Math.max(1,h.speed),victim:v.name,team:v.team,healthBefore:h.previous,healthAfter:h.health,
        healthLoss:h.healthLoss,armor:v.armor,armorPoints:armorPoints(v.armor),armorPhase:v.armorPhase,
        attacker:attacker?.name??null,attackerTeam:attacker?.team??null,sword:attacker?.weapon?.name??null,weaponEnchantedAppearance:attacker?.weapon?.enchanted??null,
        // missing animations do not disprove hits
        criticalOptions:critical.length?[true]:[false,true],sharpnessOptions:[0,1],
        evidence:{hurtSequences:hurt.map(s=>s.sequence),swingSequences:swings.map(s=>s.sequence),
          criticalSequences:critical.map(s=>s.sequence),enchantedHitSequences:magic.map(s=>s.sequence),
          nearbyOpponents:near.map(p=>p.name),distance:attacker?round(distance(attacker.position,v.position)):null},
        limitations:['Attacker inferred from isolation, facing and swing; not a direct attacker ID.',
          'Potion/absorption metadata and animation completeness are not independently verified.']};
      if(reasons.length)rejected.push({...hit,reasons});else selected.push(hit);
    }
    return {selected,rejected,lossEvents:losses.length,filters:{sequenceWindow,replayMsWindow,range},
      rejectionReasons:histogram(rejected.flatMap(h=>h.reasons))};
  }
  report(options={}){
    const evidence=this.select(options);const {windowSize=10,maxWindowSeconds=120}=options;
    const groups=new Map();
    for(const hit of evidence.selected){const key=`${hit.victim}|${hit.epoch}|${hit.armorPhase}`;
      if(!groups.has(key))groups.set(key,[]);groups.get(key).push(hit);}
    const windows=[],segments=[];
    for(const hits of groups.values())segments.push({victim:hits[0].victim,from:hits[0].t,to:hits.at(-1).t,diagnosticOnly:true,
      armor:hits[0].armor,armorPhase:hits[0].armorPhase,hits:hits.length,
      fits:MODELS.map(model=>fitProtection(hits,{model}))});
    for(const hits of groups.values())for(let i=0;i+windowSize<=hits.length;i++){
      const sample=hits.slice(i,i+windowSize);if(sample.at(-1).t-sample[0].t>maxWindowSeconds)continue;
      const fits=MODELS.map(model=>fitProtection(sample,{model}));
      windows.push({victim:sample[0].victim,from:sample[0].t,to:sample.at(-1).t,armor:sample[0].armor,
        armorPhase:sample[0].armorPhase,sequences:sample.map(h=>h.sequence),fits});
    }
    return {schema:1,experiment:'protection-inference-v1',version:this.version,replayId:this.header?.replayId,
      captureEnded:this.ended,captureEndReason:this.endReason,speeds:[...this.world.timings.hudSpeeds],accuracy:null,groundTruthLabels:0,
      definition:'Candidate Protection levels under explicit damage hypotheses, not verified upgrades or accuracy.',
      assumptions:['Protection 0-IV is uniform across equipped pieces during each window.',
        'Sword Sharpness may be 0 or I; unknown critical hits test both possibilities.',
        'An armor appearance change starts a new segment. Invisible upgrade changes can still occur inside a window.',
        'The two captures are the same replay; agreement is replication, not independent ground truth.'],
      windowSize,maxWindowSeconds,...evidence,armorChanges:this.armorChanges,segments,windows,
      individualFits:evidence.selected.map(hit=>({sequence:hit.sequence,fits:MODELS.map(model=>fitProtection([hit],{model}))}))};
  }
}
