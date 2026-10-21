import {teamName} from './team-colors.js';
import { CaptureAnalysis } from './capture-analysis.js';
import { PlayerDamage,PLAYER_DAMAGE_VERSION } from './player-damage.js';
import { inferTeamUpgrades } from './team-upgrades.js';
import { resourceStackProvenance, scoreVoidedDiamonds, VOIDED_DIAMONDS_VERSION } from './voided-diamonds.js';
import { ItemUsage, ITEM_USAGE_FIELDS } from './item-usage.js';

export const NEW_STATS = ['diamondsCollected', 'emeraldsCollected','diamondsVoided','damageDealt','damageReceived',...ITEM_USAGE_FIELDS];
const resources = ['diamond', 'emerald'];
const creditedKey = r => r === 'diamond' ? 'diamondsCollected' : 'emeraldsCollected';
const distance = (a, b) => Math.hypot(a.x-b.x, a.y-b.y, a.z-b.z);
const copy = p => p ? { ...p } : null;
const key = p => `${p.x},${p.y},${p.z}`;
const sameName = (a,b) => a && b && a.toLowerCase() === b.toLowerCase();
const releaseNear = (item, position) => distance(item,position)<=2 && item.y-position.y>=.7 && item.y-position.y<=1.9;
function releaseAlongMove(item, player) {
  const a=player.moveFrom,b=player.position;
  if(!a || !b || distance(a,b)>4)return false;
  const delta={x:b.x-a.x,y:b.y-a.y,z:b.z-a.z};
  const length=delta.x**2+delta.y**2+delta.z**2;
  if(!length)return false;
  const fraction=Math.max(0,Math.min(1,((item.x-a.x)*delta.x+(item.y-1.3-a.y)*delta.y+(item.z-a.z)*delta.z)/length));
  return releaseNear(item,{x:a.x+delta.x*fraction,y:a.y+delta.y*fraction,z:a.z+delta.z*fraction});
}

// delay drops until death evidence arrives
export class ReplayStats {
  constructor(version, {parseDeaths = true} = {}) {
    this.world = new CaptureAnalysis(version);
    this.upgradeEvidence = new PlayerDamage(version);
    this.itemUsage = new ItemUsage(version);
    this.upgradeResult = null;
    this.damageResult = null;
    this.voidResult = null;
    this.resourceProvenance = null;this.unresolvedResourceAmounts = new Set();
    this.version = version; this.sequence = 0; this.clock = null; this.parseDeaths = parseDeaths;
    this.players = new Map(); this.items = new Map(); this.collected = new Set();
    this.observedCollections = new Map();
    this.queue = []; this.deaths = []; this.deathKeys = new Set();
    this.resourceEvents = []; this.generators = new Map();
    this.issues = new Set(); this.invalid = false; this.started = false; this.finished = false;
    this.epoch = 0; this.seenPlayers = new Set(); this.seenCombatTeams = new Set(); this.lastSec = null;
  }
  player(name) {
    if (!name || !/^[A-Za-z0-9_]{1,16}$/.test(name)) return null;
    if (!this.players.has(name)) this.players.set(name, {
      diamondsCollected: 0, emeraldsCollected: 0, carried: {diamond:0,emerald:0},
      rawPickups: {diamond:0,emerald:0} });
    return this.players.get(name);
  }
  setPlayerTeam(name,team){this.upgradeEvidence.setPlayerTeam(name,team);this.seenCombatTeams.add(team);}
  invalidate(reason) { this.invalid = true; this.upgradeResult=null; this.damageResult=null; this.voidResult=null; this.issues.add(reason); }
  setPlayback(hud) {
    const resolution=Math.max(1,Math.ceil(hud.speed || 1),Math.ceil(this.clock?.speed || 1));
    if (this.clock && (hud.elapsedSec < this.clock.elapsedSec || hud.elapsedSec - this.clock.elapsedSec > resolution*2 || hud.totalSec!==this.clock.totalSec)) {
      this.invalidate('Replay navigation detected; resource totals require a fresh recording from the beginning.');
      this.epoch++;
    }
    if (hud.state === 'playing' && !this.started) {
      this.started = true;
      if (hud.elapsedSec > resolution) this.invalidate('Recording began after the start of the replay.');
    }
    this.clock = { ...hud, epoch: this.epoch, resolution };
    this.lastSec = hud.elapsedSec;
    if (hud.state === 'finished') { if(!this.invalid)this.flush(Infinity); this.finished = true; }
  }
  snapshot(entity, id) {
    const team=this.world.playerTeams.get(this.world.names.get(entity.uuid)) ?? null;
    const prefix=this.world.teams.get(team)?.prefix || '';
    const color=[...prefix.matchAll(/\u00a7([a-f0-9])/gi)].at(-1)?.[1]?.toLowerCase();
    return { player: this.world.playerName(entity), entityId:id, generation:entity.generation,
      position:copy(entity.position), yaw:entity.yaw, pitch:entity.pitch,
      moveFrom:this.world.legacy && this.clock?.speed>1 && entity.recentMove && this.lastRow?.seq-entity.recentMove.sequence<=16 &&
        this.lastRow?.t-entity.recentMove.replaySec<=this.clock?.resolution ? copy(entity.recentMove.from) : null,
      team,combatTeam:this.upgradeEvidence.teamOverrides.get(String(this.world.playerName(entity)).toLowerCase()) || teamName(color) || team };
  }
  roster() {
    return [...this.world.entities].filter(([,e])=>e.kind==='player').map(([id,e])=>this.snapshot(e,id));
  }
  nearbyChest(position) { return position && this.world.nearestChest(position)?.distance <= 5; }
  observe(name, data, state = 'play', sourceSequence, receivedMs=Date.now()) {
    if (!['play','configuration'].includes(state)) return;
    const row = {type:'packet', name, data, sequence:sourceSequence ?? this.sequence++, receivedMs, replay:this.clock};
    if(!this.invalid && !this.finished)this.upgradeEvidence.observe(row);
    const active = this.clock?.state === 'playing' && !this.invalid && !this.finished;
    const w = this.world;
    const lengths = [w.resourceSpawns.length,w.resourcePickups.length,w.deaths.length];
    const removed=active && name==='entity_destroy' ? (data.entityIds??[]).map(id=>w.entities.get(id)).filter(Boolean) : [];
    const rawCollected=active && name==='collect' ? w.entities.get(data.collectedEntityId) : null;
    const before = this.roster();
    this.lastRow={t:this.clock?.elapsedSec,seq:row.sequence,roster:before};
    if (active && ['login','respawn'].includes(name)) this.invalidate('World changed during playback.');
    w.observe(row);
    if (!this.invalid && !this.finished) this.itemUsage.observe(row, w);
    if (!active || this.invalid) return;
    const t = this.clock.elapsedSec, seq = row.sequence;
    if(rawCollected) {
      const pickups=this.observedCollections.get(rawCollected.generation)??[];
      pickups.push({t,seq});this.observedCollections.set(rawCollected.generation,pickups);
      const known=this.items.get(rawCollected.generation);if(known)known.lifecycle.pickups=pickups;
    }
    for (const p of this.roster()) if (p.player) {
      this.seenPlayers.add(p.player); this.player(p.player);
      if(teamName(p.combatTeam))this.seenCombatTeams.add(p.combatTeam);
    }
    const entity = w.entities.get(data.entityId);
    for (const spawn of w.resourceSpawns.slice(lengths[0])) {
      const item=w.entities.get(spawn.entityId); if(!item)continue;
      const location=key(spawn.position), gen=this.generators.get(location) || {position:copy(spawn.position),resource:spawn.resource,count:0};
      gen.count++; this.generators.set(location,gen);
      const entry={...spawn, generation:item.generation,t,seq,resolution:this.clock.resolution,roster:this.roster(),position:copy(spawn.position)};
      entry.voidBoundary=w.world.minY;
      entry.lifecycle={samples:[{t,seq,position:copy(item.position),count:item.item.count,kind:'spawn'}],
        pickups:this.observedCollections.get(item.generation)??[],removed:null};
      this.items.set(item.generation,entry); this.queue.push({kind:'spawn',t,seq,item:entry});
    }
    for (const pickup of w.resourcePickups.slice(lengths[1])) {
      this.queue.push({kind:'pickup',t,seq,...pickup,nearChest:this.nearbyChest(pickup.collectorPosition)});
    }
    const resourceItem=entity && this.items.get(entity.generation);
    if(resourceItem && ['entity_metadata','rel_entity_move','entity_move_look','entity_teleport','sync_entity_position'].includes(name)) {
      const last=resourceItem.lifecycle.samples.at(-1),count=entity.item?.count;
      if(last.seq!==seq && (name!=='entity_metadata' || count!==last.count))resourceItem.lifecycle.samples.push({t,seq,
        position:copy(entity.position),count,kind:name==='entity_metadata'?'metadata':'movement'});
    }
    for(const item of removed) {
      const tracked=this.items.get(item.generation);
      if(tracked)tracked.lifecycle.removed={t,seq,position:copy(item.position),count:item.item?.count};
    }
    if(this.parseDeaths)for (const death of w.deaths.slice(lengths[2])) this.recordDeath(death);
    if (entity?.kind==='player' && ['rel_entity_move','entity_move_look','entity_teleport','sync_entity_position','named_entity_spawn','spawn_entity'].includes(name)) {
      const player=w.playerName(entity);
      if (player && this.nearbyChest(entity.position)) this.queue.push({kind:'chest',player,t,seq});
    }
    // speed affects replay time between samples
    this.flush(t-Math.max(2,this.clock.resolution*2));
  }
  recordDeath(death) {
    if(this.clock?.state!=='playing' || this.invalid || this.finished)return;
    const {t,seq,roster}=this.lastRow || {t:this.clock.elapsedSec,seq:this.sequence,roster:this.roster()};
    const id=`${t}|${death.raw}`;if(this.deathKeys.has(id))return;this.deathKeys.add(id);
    const victim=roster.find(p=>sameName(p.player,death.victim)),killer=roster.find(p=>sameName(p.player,death.killer));
    const event={kind:'death',...death,t,seq,id,resolution:this.clock.resolution,position:victim?.position ?? null,killerNearChest:this.nearbyChest(killer?.position)};
    Object.assign(event,this.upgradeEvidence.recordDeath(death));
    this.itemUsage.recordDeath(death,this.world);
    this.deaths.push(event);this.queue.push(event);
    for(const entity of this.world.entities.values())if(sameName(this.world.playerName(entity),death.victim))delete entity.health;
    return event;
  }
  log(event) { this.resourceEvents.push(event); }
  credit(name, event) {
    const p=this.player(name); if(!p)return;
    for(const resource of resources) if(p.carried[resource]>0) {
      const quantity=p.carried[resource];p[creditedKey(resource)]+=quantity;p.carried[resource]=0;
      this.log({kind:'credit',t:event.t,sequence:event.seq,player:name,resource,quantity});
    }
  }
  classify(item) {
    if(item.origin)return item.origin;
    const gridCenter=Object.values(item.position).every(v=>Math.abs((v-Math.floor(v))-.5)<.001);
    // repeated positions cannot prove generators
    if(gridCenter) return item.origin={kind:'generator'};
    const death=this.deaths.filter(d=>d.position && Math.abs(d.t-item.t)<=Math.max(d.resolution,item.resolution) &&
      Math.abs(d.seq-item.seq)<=256 && distance(d.position,item.position)<=2.5);
    if(death.length===1) return item.origin={kind:'death',death:death[0].id};
    // interpolate only the immediately preceding move
    const candidates=item.roster.filter(p=>p.player && p.position &&
      (releaseNear(item.position,p.position) || releaseAlongMove(item.position,p)));
    if(candidates.length===1) return item.origin={kind:'throw',player:candidates[0].player,confidence:.7};
    this.issues.add('Some resource releases have unresolved ownership.');
    return item.origin={kind:'unknown'};
  }
  resource(event) {
    const {kind,t,seq}=event;
    if(kind==='spawn') {
      const item=event.item,origin=this.classify(item);
      if(origin.kind==='throw') {
        const p=this.player(origin.player);if(!p)return;
        const physicalQuantity=this.resourceProvenance?.state.get(item.generation)?.initialQuantity??null;
        if(physicalQuantity===null) {
          this.unresolvedResourceAmounts.add(item.resource);
          this.issues.add(`Some ${item.resource} release quantities could not be reconciled after stack merging.`);
          this.log({kind:'throw_unresolved',t,sequence:seq,player:origin.player,resource:item.resource,
            groundCount:item.count,itemEntityId:item.entityId,reason:'unresolved_initial_stack_merge'});
          return;
        }
        const quantity=Math.min(p.carried[item.resource],Math.max(0,physicalQuantity));
        p.carried[item.resource]-=quantity;
        this.log({kind:'throw',t,sequence:seq,player:origin.player,resource:item.resource,quantity,
          physicalQuantity,groundCount:item.count,confidence:origin.confidence,itemEntityId:item.entityId});
      }
    } else if(kind==='pickup') {
      if(this.collected.has(event.itemGeneration))return;
      this.collected.add(event.itemGeneration);
      const item=this.items.get(event.itemGeneration),origin=item && this.classify(item);
      if(origin?.kind==='death') {
        this.log({kind:'death_drop_suppressed',t,sequence:seq,player:event.collector,resource:event.resource,
          quantity:event.metadataCount,death:origin.death,itemEntityId:event.itemEntityId});return;
      }
      const p=this.player(event.collector),quantity=event.metadataCount;
      if(!p || !Number.isInteger(quantity) || quantity<=0){this.issues.add('A resource pickup had no usable ground-stack quantity.');return;}
      p.rawPickups[event.resource]+=quantity;p.carried[event.resource]+=quantity;
      this.log({kind:'pickup',t,sequence:seq,player:event.collector,resource:event.resource,quantity,
        packetQuantity:event.packetCount,itemEntityId:event.itemEntityId});
      if(event.nearChest)this.credit(event.collector,event);
    } else if(kind==='chest') this.credit(event.player,event);
    else if(kind==='death') {
      const victim=this.player(event.victim),killer=event.killer && !sameName(event.victim,event.killer) ? this.player(event.killer) : null;
      if(!victim)return;
      for(const resource of resources) {
        const quantity=victim.carried[resource];victim.carried[resource]=0;
        if(killer)killer.carried[resource]+=quantity;
        if(quantity)this.log({kind:killer?'kill_transfer':'unresolved_loss',t,sequence:seq,
          victim:event.victim,killer:killer?event.killer:null,resource,quantity});
      }
      if(killer && event.killerNearChest)this.credit(event.killer,event);
    }
  }
  flush(through) {
    if(this.queue.some(event=>event.t<=through && event.kind==='spawn'))
      this.resourceProvenance=resourceStackProvenance(this.items.values());
    const pending=[];
    for(const event of this.queue) {if(event.t<=through)this.resource(event);else pending.push(event);}
    this.queue=pending;
  }
  result() {
    if(this.finished && !this.invalid)this.flush(Infinity);
    const hasChests=this.world.replayChests.length>0;
    const damageReady=this.finished && !this.invalid && this.started && this.upgradeEvidence.world.healthSamples.length>0 && this.upgradeEvidence.rawErrors===0;
    const damage=damageReady?(this.damageResult??=this.upgradeEvidence.score()):null;
    const resourceDecodeErrors=Object.keys(this.world.decodeErrors).some(key=>key.startsWith('playing:'));
    const itemUsage=this.itemUsage.result({finished:this.finished,started:this.started,invalid:this.invalid,
      decodeErrors:resourceDecodeErrors,names:[...this.seenPlayers]});
    const voidReady=this.finished && this.started && !this.invalid && this.seenPlayers.size>0 && !resourceDecodeErrors;
    const voids=voidReady?(this.voidResult??=scoreVoidedDiamonds(this.items.values(),item=>this.classify(item))):null;
    const players=Object.fromEntries([...this.players].map(([name,p])=>[name,{
      diamondsCollected:!this.invalid && hasChests && !this.unresolvedResourceAmounts.has('diamond')?p.diamondsCollected:null,
      emeraldsCollected:!this.invalid && hasChests && !this.unresolvedResourceAmounts.has('emerald')?p.emeraldsCollected:null,
      diamondsVoided:voids && this.seenPlayers.has(name)?(voids.players[name]??0):null,
      damageDealt:damage?.players[name]?.dealt??null,damageReceived:damage?.players[name]?.received??null,
      damageByOpponent:damage?.players[name]?.opponents??null,
      ...Object.fromEntries(ITEM_USAGE_FIELDS.map(field=>[field,itemUsage.players[name]?.[field]??null])),
      resourceCarried:{...p.carried},resourcePickups:{...p.rawPickups}
    }]));
    const upgradeStatus=this.invalid?'invalid':this.finished?'estimated':'incomplete';
    const upgrades=this.upgradeResult??inferTeamUpgrades(upgradeStatus==='estimated'?this.upgradeEvidence.select().selected:[],
      {status:upgradeStatus,totalSec:this.clock?.totalSec,teamNames:[...this.seenCombatTeams]});
    if(this.finished)this.upgradeResult=upgrades;
    return {players,teamUpgrades:upgrades,tracking:{version:4,protocolVersion:this.version,status:this.invalid?'invalid':this.started?'tracked':'unavailable',
      damage:{version:PLAYER_DAMAGE_VERSION,status:damage?'tracked':this.invalid?'invalid':this.finished?'unavailable':'incomplete',scope:'attributed-player-damage',
        rule:'Yaw, pitch and distance attribution; credited void kills receive remaining observed HP once.',
        ...(damage?{totals:damage.totals,voidFinishDamage:damage.voidFinishDamage}:{}),accuracy:null},
      damageEvents:damage?.events??[],
      itemUsage:itemUsage.tracking,itemUsageEvents:itemUsage.events,
      resourceRule:'Credit carried ground-stack quantities within 5 blocks of an ender chest; clear carried after credit.',
      resourceVersion:2,
      unresolvedResourceAmounts:[...this.unresolvedResourceAmounts],
      voidedDiamonds:{version:VOIDED_DIAMONDS_VERSION,status:voids?'tracked':this.invalid?'invalid':this.finished?'unavailable':'incomplete',
        rule:'Inferred player diamond releases observed moving below the world build floor and then disappearing without pickup; ambiguous ownership or merged quantities remain unresolved.',
        unresolvedEvents:voids?.unresolvedEvents??null,unresolvedCollections:this.world.collections.unknownItem},
      playbackSpeeds:[...this.world.timings.hudSpeeds],
      issues:[...this.issues],unresolvedCollections:this.world.collections.unknownItem,
      chunkErrors:this.world.chunkErrors,decodeErrors:this.world.decodeErrors,enderChests:this.world.replayChests,
      resourceEvents:[...this.resourceEvents,...(voids?.events??[])]}};
  }
}
