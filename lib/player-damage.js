import {DamageExperiment,summarizeDamage} from './damage-experiment.js';

const key=name=>String(name??'').toLowerCase();
export const PLAYER_DAMAGE_VERSION=2;

export class PlayerDamage extends DamageExperiment {
  constructor(version,{parseDeaths=false}={}) {
    super(version);this.parseDeaths=parseDeaths;this.lives=new Map();this.nextLife=0;
    this.finishes=[];this.deathKeys=new Set();
  }
  actor(id) {
    const entity=this.world.entities.get(id);
    // ignore dead entities until respawn
    if(entity?.damageClosed)return null;
    const p=super.actor(id);
    if(!p)return null;
    entity.damageLife??=++this.nextLife;
    return {...p,lifeId:entity.damageLife};
  }
  observe(row) {
    if(row.type!=='packet'){super.observe(row);return;}
    const playing=row.replay?.state==='playing',before=this.health.length,deathCount=this.world.deaths.length;
    const entity=this.world.entities.get(row.data.entityId),healthKey=this.world.legacy?6:9;
    // positive health starts a new life
    if(entity?.damageClosed && row.name==='entity_metadata' && row.data.metadata?.some(f=>f.key===healthKey && Number.isFinite(f.value) && f.value>0)) {
      delete entity.health;delete entity.damageClosed;entity.damageLife=++this.nextLife;
    }
    super.observe(row);
    if(!playing)return;
    const rosterChanged=['player_info','player_info_update','player_list_item','teams','scoreboard_team'].includes(row.name);
    const ids=rosterChanged?this.world.entities.keys():row.data.entityId!==undefined?[row.data.entityId]:[];
    for(const id of ids) {
      const actor=this.actor(id);if(!actor)continue;
      const e=this.world.entities.get(id),old=this.lives.get(key(actor.name));
      if(e.damageClosed){delete e.health;continue;}
      const life=old?.lifeId===actor.lifeId?old:{lifeId:actor.lifeId,epoch:row.replay.epoch,voidStart:null};
      Object.assign(life,{...actor,lastSeen:this.stamp(row)});
      // preserve the last known health
      if(actor.health===undefined && old?.lifeId===actor.lifeId)life.health=old.lastHealth;
      if(Number.isFinite(life.health))life.lastHealth=life.health;
      if(actor.position?.y<0 && life.voidStart===null)life.voidStart=row.sequence;
      // clutches end the fall
      if(actor.position?.y>=0)life.voidStart=null;
      this.lives.set(key(actor.name),life);
    }
    this.health.splice(before,this.health.length-before,...this.health.slice(before).filter(h=>!this.world.entities.get(h.victim.entityId)?.damageClosed));
    if(this.parseDeaths)for(const death of this.world.deaths.slice(deathCount))this.recordDeath(death);
  }
  recordDeath(death) {
    const row=this.lastRow;if(row?.replay?.state!=='playing')return;
    const victim=this.lives.get(key(death.victim));if(!victim || victim.closed || victim.epoch!==row.replay.epoch)return;
    const id=`${row.replay.epoch}:${victim.lifeId}`;if(this.deathKeys.has(id))return;this.deathKeys.add(id);
    const killer=this.lives.get(key(death.killer));
    victim.team=this.teamOverrides.get(key(victim.name))??victim.team;
    if(killer)killer.team=this.teamOverrides.get(key(killer.name))??killer.team;
    const credited=killer && key(killer.name)!==key(victim.name) && killer.team && victim.team && killer.team!==victim.team;
    // usernames cannot prove void deaths
    const isVoid=victim.position?.y<0 || /\bvoid\b/i.test(death.rawCause??'');
    const recent=victim.lastSeen && row.replay.elapsedSec-victim.lastSeen.t<=Math.max(8,2*(row.replay.speed??1));
    if(credited && isVoid && recent && Number.isFinite(victim.lastHealth))this.finishes.push({
      ...this.stamp(row),victim:victim.name,attacker:killer.name,lifeId:victim.lifeId,
      voidStart:victim.voidStart,remaining:Math.max(0,victim.lastHealth),raw:death.raw,
    });
    victim.closed=true;
    const e=this.world.entities.get(victim.entityId);
    if(e?.damageLife===victim.lifeId){e.damageClosed=true;delete e.health;}
    return {sequence:row.sequence,lifeId:victim.lifeId};
  }
  score() {
    // apply resolved teams to earlier snapshots
    for(const h of this.health)for(const actor of [h.victim,...h.roster])actor.team=this.teamOverrides.get(key(actor.name))??actor.team;
    for(const signal of this.signals)for(const actor of [signal.actor,...signal.roster??[]])
      actor.team=this.teamOverrides.get(key(actor.name))??actor.team;
    const health=new Map(this.health.map(h=>[h.sequence,h]));
    const events=this.attribute().map(e=>{
      const h=health.get(e.sequence);
      // void ticks cannot identify attackers
      return {...e,lifeId:h.victim.lifeId,...(h.victim.position?.y<0?{attacker:null,method:'unassigned',reason:'void-health-loss'}:{})};
    });
    for(const finish of this.finishes) {
      let losses=events.filter(e=>e.lifeId===finish.lifeId && e.sequence<=finish.sequence && e.sequence>=finish.voidStart && finish.voidStart!==null);
      if(finish.voidStart===null && finish.remaining===0) {
        // late void messages recover adjacent final drops
        losses=events.filter(e=>e.lifeId===finish.lifeId && e.sequence<finish.sequence && finish.sequence-e.sequence<=256 &&
          finish.t-e.t<=Math.max(2,finish.speed*2) && health.get(e.sequence).health===0).slice(-1);
      }
      for(const e of losses)Object.assign(e,{attacker:finish.attacker,method:'credited-void-loss',reason:null,candidates:[]});
      if(finish.remaining>0)events.push({sequence:finish.sequence,t:finish.t,victim:finish.victim,attacker:finish.attacker,
        lifeId:finish.lifeId,healthLoss:finish.remaining,method:'credited-void-finish',reason:null,candidates:[],hurtSequences:[]});
    }
    events.sort((a,b)=>a.sequence-b.sequence);
    const summary=summarizeDamage(events,[...this.observedNames]);
    return {...summary,events,voidFinishDamage:events.filter(e=>e.method.startsWith('credited-void')).reduce((n,e)=>n+e.healthLoss,0)};
  }
}
