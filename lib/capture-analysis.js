import minecraftData from 'minecraft-data';
import chunkFactory from 'prismarine-chunk';
import { Vec3 } from 'vec3';
import { packetText, unwrapNbt } from './packet-capture.js';
import { parseMessage } from './death-parser.js';

const cleanName = name => typeof name === 'string' ? name.replace(/\u00a7./g, '') : null;
const locationKey = p => `${p.x},${p.y},${p.z}`;
const colors=['black','dark_blue','dark_green','dark_aqua','dark_red','dark_purple','gold','gray','dark_gray','blue','green','aqua','red','light_purple','yellow','white'];
// color-only prefixes still identify teams
function teamText(value) {
  value=unwrapNbt(value);
  if(typeof value==='string') {try {const parsed=JSON.parse(value);if(parsed && typeof parsed==='object')return teamText(parsed);}catch {}return value;}
  if(Array.isArray(value))return value.map(teamText).join('');
  if(!value || typeof value!=='object')return '';
  const color=colors.indexOf(value.color);
  return (color>=0?'§'+color.toString(16):'')+(value.text ?? '')+(value.extra || []).map(teamText).join('');
}
export const chestDistance = (player, chest) => Math.hypot(player.x - chest.x - 0.5, player.y - chest.y - 0.5, player.z - chest.z - 0.5);

export class CaptureAnalysis {
  constructor(version) {
    this.version = version;
    this.legacy = version === '1.8.9';
    this.registry = minecraftData(version);
    this.Chunk = chunkFactory(version);
    this.names = new Map();
    this.teams = new Map();
    this.playerTeams = new Map();
    this.entities = new Map();
    this.chests = new Map();
    this.replayChests = [];
    this.dimensions = [];
    this.world = { minY: 0, worldHeight: 256 };
    this.generation = 0;
    this.replayEpoch = null;
    this.complete = false;
    this.endReason = null;
    this.lastHud = null;
    this.counts = {};
    this.decodeErrors = {};
    this.healthSamples = [];
    this.healthChanges = [];
    this.hurts = [];
    this.damageEvents = [];
    this.resourceSpawns = [];
    this.resourcePickups = [];
    this.unresolvedCollections = [];
    this.collections = { total: 0, unknownItem: 0, unknownCollector: 0 };
    this.chestVisits = [];
    this.deaths = [];
    this.chunkErrors = [];
    this.timings = { hudSpeeds: new Set(), epochs: new Set(), firstSec: null, lastSec: null };
  }

  event(row, value) {
    return { sequence: row.sequence, replaySec: row.replay?.elapsedSec ?? null,
      epoch: row.replay?.epoch ?? null, ...value };
  }
  playerName(entity) {
    const raw = entity ? this.names.get(entity.uuid) ?? entity.name : null;
    if (!raw) return null;
    const team = this.teams.get(this.playerTeams.get(raw));
    // team suffixes may complete truncated names
    const rendered = cleanName((team?.prefix ?? '') + raw + (team?.suffix ?? ''));
    return /^[A-Za-z0-9_]{1,16}$/.test(rendered) ? rendered : cleanName(raw);
  }
  isPlayer(entity) { return entity?.kind === 'player'; }

  observe(row) {
    if (row.type === 'end') { this.complete = true; this.endReason = row.reason; return; }
    if (row.type !== 'packet') return;
    const { name, data, replay } = row;
    const playing = replay?.state === 'playing';
    if (replay) this.lastHud = replay;
    if (playing) {
      this.counts[name] = (this.counts[name] || 0) + 1;
      this.timings.hudSpeeds.add(replay.speed);
      this.timings.epochs.add(replay.epoch);
      this.timings.firstSec ??= replay.elapsedSec;
      this.timings.lastSec = replay.elapsedSec;
      if (this.replayEpoch !== null && this.replayEpoch !== replay.epoch) {
        // rewinds reset health baselines
        for (const entity of this.entities.values()) { delete entity.health; entity.nearChest = null; }
      }
      this.replayEpoch = replay.epoch;
    }
    if (name === 'registry_data' && data.id === 'minecraft:dimension_type') {
      this.dimensions = data.entries.map(entry => unwrapNbt(entry.value));
    }
    if (name === 'login' || name === 'respawn') {
      this.entities.clear(); this.chests.clear(); this.teams.clear(); this.playerTeams.clear();
      const dimension = this.dimensions[data.worldState?.dimension];
      this.world = { minY: dimension?.min_y ?? 0, worldHeight: dimension?.height ?? 256 };
      return;
    }
    if (['player_info', 'player_info_update', 'player_list_item'].includes(name)) {
      for (const entry of data.data || []) {
        const playerName = entry.name ?? entry.player?.name;
        if (playerName) this.names.set(entry.uuid ?? entry.UUID, playerName);
      }
    }
    if (name === 'teams' || name === 'scoreboard_team') {
      const mode = typeof data.mode === 'number' ? ['add', 'remove', 'change', 'join', 'leave'][data.mode] : data.mode;
      if (mode === 'remove') {
        this.teams.delete(data.team);
        for (const [player, team] of this.playerTeams) if (team === data.team) this.playerTeams.delete(player);
      } else {
        const team = this.teams.get(data.team) ?? { prefix: '', suffix: '' };
        if (data.prefix !== undefined) team.prefix = teamText(data.prefix);
        if (data.suffix !== undefined) team.suffix = teamText(data.suffix);
        this.teams.set(data.team, team);
        for (const player of data.players ?? []) {
          if (mode === 'leave') this.playerTeams.delete(player);
          else this.playerTeams.set(player, data.team);
        }
      }
    }
    if (name === 'capture_unparsed') {
      const buffer = Buffer.isBuffer(data.raw) ? data.raw : Buffer.from(data.raw.$buffer, 'base64');
      let id = 0;
      for (let i = 0; i < Math.min(buffer.length, 5); i++) { id |= (buffer[i] & 127) << (i * 7); if (!(buffer[i] & 128)) break; }
      const mapping = this.registry.protocol.play.toClient.types.packet[1][0].type[1].mappings;
      const packetName = mapping['0x' + id.toString(16).padStart(2, '0')] ?? `id:${id}`;
      const key = `${playing ? 'playing' : 'outside_playback'}:${packetName}`;
      this.decodeErrors[key] = (this.decodeErrors[key] || 0) + 1;
      return;
    }
    if (name === 'map_chunk') this.loadChunk(data);
    if (name === 'map_chunk_bulk' && this.legacy) {
      const buffer=Buffer.isBuffer(data.data)?data.data:Buffer.from(data.data.$buffer,'base64');
      let offset=0;
      for(const meta of data.meta) {
        const sections=meta.bitMap.toString(2).replaceAll('0','').length;
        const length=sections*(data.skyLightSent?12288:10240)+256;
        this.loadChunk({...meta,groundUp:true,skyLightSent:data.skyLightSent,chunkData:buffer.subarray(offset,offset+length)});
        offset+=length;
      }
    }
    if (name === 'block_change') {
      const block = this.registry.blocksByStateId[data.type];
      if (block?.name === 'ender_chest') this.chests.set(locationKey(data.location), { ...data.location });
      else this.chests.delete(locationKey(data.location));
    }
    // keep replay locations across lobby transitions
    if (playing) this.replayChests = [...this.chests.values()];
    if (name === 'named_entity_spawn' || name === 'spawn_entity') {
      const kind = name === 'named_entity_spawn' || (!this.legacy && data.type === this.registry.entitiesByName.player.id)
        ? 'player' : ((!this.legacy && data.type === this.registry.entitiesByName.item.id) || (this.legacy && data.type === 2) ? 'item' : 'other');
      const divisor = this.legacy ? 32 : 1;
      const entity = { kind, uuid: data.playerUUID ?? data.objectUUID, generation: ++this.generation,
        yaw: data.yaw == null ? null : data.yaw * 360 / 256,
        pitch: data.pitch == null ? null : data.pitch * 360 / 256,
        position: { x: data.x / divisor, y: data.y / divisor, z: data.z / divisor }, spawnData: data };
      this.entities.set(data.entityId, entity);
      if (data.metadata) this.metadata(row, data.entityId, data.metadata);
    }
    if (name === 'entity_metadata') this.metadata(row, data.entityId, data.metadata);
    const entity = this.entities.get(data.entityId);
    if (entity && ['entity_look', 'entity_move_look', 'entity_teleport', 'sync_entity_position'].includes(name)) {
      if (data.yaw != null) entity.yaw = name === 'sync_entity_position' ? data.yaw : data.yaw * 360 / 256;
      if (data.pitch != null) entity.pitch = name === 'sync_entity_position' ? data.pitch : data.pitch * 360 / 256;
    }
    if (entity && ['entity_teleport', 'sync_entity_position'].includes(name)) {
      delete entity.recentMove;
      const divisor = this.legacy ? 32 : 1;
      entity.position = { x: data.x / divisor, y: data.y / divisor, z: data.z / divisor };
    }
    if (entity?.position && ['rel_entity_move', 'entity_move_look'].includes(name)) {
      entity.recentMove = {from:{...entity.position},sequence:row.sequence,replaySec:replay?.elapsedSec};
      const divisor = this.legacy ? 32 : 4096;
      entity.position.x += data.dX / divisor; entity.position.y += data.dY / divisor; entity.position.z += data.dZ / divisor;
    }
    if (playing && this.isPlayer(entity) && ['rel_entity_move', 'entity_move_look', 'entity_teleport', 'sync_entity_position'].includes(name)) {
      const nearby = this.nearestChest(entity.position);
      const key = nearby && nearby.distance <= 5 ? locationKey(nearby.chest) : null;
      if (key && entity.nearChest !== key) this.chestVisits.push(this.event(row, {
        player: this.playerName(entity), entityId: data.entityId, ...nearby, playerPosition: { ...entity.position }
      }));
      entity.nearChest = key;
    }
    if (playing && name === 'collect') {
      this.collections.total++;
      const item = this.entities.get(data.collectedEntityId), collector = this.entities.get(data.collectorEntityId);
      if (!item?.item) this.collections.unknownItem++;
      if (!this.playerName(collector)) this.collections.unknownCollector++;
      if (!item?.item || !this.playerName(collector)) this.unresolvedCollections.push(this.event(row, {
        ...data, collector: this.playerName(collector),
        reason: !item?.item ? 'No matching item-stack metadata in the observed entity state.' : 'Collector name unresolved.'
      }));
      if (['diamond', 'emerald'].includes(item?.item?.name)) {
        this.resourcePickups.push(this.event(row, { resource: item.item.name, metadataCount: item.item.count,
          packetCount: data.pickupItemCount ?? null, itemEntityId: data.collectedEntityId,
          itemGeneration: item.generation, collectorEntityId: data.collectorEntityId,
          collector: this.playerName(collector), collectorPosition: collector?.position ? { ...collector.position } : null,
          nearestChest: collector?.position ? this.nearestChest(collector.position) : null }));
      }
    }
    if (playing && (name === 'hurt_animation' || (name === 'entity_status' && data.entityStatus === 2))) {
      this.hurts.push(this.event(row, { player: this.playerName(entity), ...data }));
    }
    if (playing && name === 'damage_event') this.damageEvents.push(this.event(row, { player: this.playerName(entity), ...data }));
    if (playing && ['chat', 'system_chat'].includes(name) && data.position !== 2 && !data.isActionBar && !data.overlay) {
      const death = parseMessage(packetText(name, data));
      if (death?.type === 'death') {
        this.deaths.push(this.event(row, death));
        // respawns reset the damage baseline
        for (const candidate of this.entities.values()) if (this.playerName(candidate) === death.victim) delete candidate.health;
      }
    }
    if (name === 'entity_destroy') for (const id of data.entityIds || []) this.entities.delete(id);
  }

  metadata(row, id, metadata) {
    const entity = this.entities.get(id);
    if (!entity) return;
    for (const field of metadata) {
      if (this.isPlayer(entity) && field.key === (this.legacy ? 6 : 9) && Number.isFinite(field.value) && field.value >= 0) {
        const previous = entity.health;
        entity.health = field.value;
        if (row.replay?.state !== 'playing') continue;
        const sample = this.event(row, { player: this.playerName(entity), entityId: id, key: field.key, health: field.value });
        this.healthSamples.push(sample);
        if (previous !== undefined && previous !== field.value) this.healthChanges.push({ ...sample, previous,
          healthLoss: Math.max(0, previous - field.value), healing: Math.max(0, field.value - previous) });
      }
      const value = field.value;
      if (entity.kind === 'item' && value && typeof value === 'object' && (value.itemId !== undefined || value.blockId !== undefined)) {
        const itemId = value.itemId ?? value.blockId;
        entity.item = { id: itemId, name: this.registry.items[itemId]?.name, count: value.itemCount };
        if (!entity.resourceLogged && ['diamond', 'emerald'].includes(entity.item.name) && row.replay?.state === 'playing') {
          entity.resourceLogged = true;
          const nearbyPlayers = [...this.entities.values()].filter(other => this.isPlayer(other) && other.position)
            .map(other => ({ player: this.playerName(other), distance: Math.hypot(other.position.x - entity.position.x,
              other.position.y - entity.position.y, other.position.z - entity.position.z) })).filter(other => other.distance <= 3);
          this.resourceSpawns.push(this.event(row, { entityId: id, resource: entity.item.name, count: entity.item.count,
            position: { ...entity.position }, spawnFields: Object.keys(entity.spawnData), objectData: entity.spawnData.objectData,
            nearbyPlayers, attribution: 'No thrower assigned; nearby players are only candidates.' }));
        }
      }
    }
  }

  loadChunk(data) {
    try {
      const chunk = new this.Chunk(this.world);
      const buffer = Buffer.isBuffer(data.chunkData) ? data.chunkData : Buffer.from(data.chunkData.$buffer, 'base64');
      // empty full chunks signal unloads
      if(this.legacy && data.groundUp && data.bitMap===0 && buffer.length===0){
        for(const [key,chest]of this.chests)if(Math.floor(chest.x/16)===data.x && Math.floor(chest.z/16)===data.z)this.chests.delete(key);
        return;
      }
      if (this.legacy) chunk.load(buffer, data.bitMap, data.skyLightSent ?? true, data.groundUp);
      else chunk.load(buffer);
      for (const [key, chest] of this.chests) if (Math.floor(chest.x / 16) === data.x && Math.floor(chest.z / 16) === data.z &&
        (!this.legacy || data.groundUp || (data.bitMap & (1 << Math.floor(chest.y/16))))) this.chests.delete(key);
      for (let section = 0; section < this.world.worldHeight / 16; section++) {
        if(this.legacy && !(data.bitMap & (1 << section)))continue;
        const entry = chunk.sections?.[section];
        if (!entry && !this.legacy) continue;
        if (entry?.palette && !entry.palette.some(id => this.registry.blocksByStateId[id]?.name === 'ender_chest')) continue;
        const min = this.world.minY + section * 16;
        for (let y = min; y < min + 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
          if (chunk.getBlockType(new Vec3(x,y,z)) !== this.registry.blocksByName.ender_chest.id) continue;
          const chest = { x: data.x * 16 + x, y, z: data.z * 16 + z };
          this.chests.set(locationKey(chest), chest);
        }
      }
    } catch (error) { if (this.chunkErrors.length < 20) this.chunkErrors.push({ x: data.x, z: data.z, error: error.message }); }
  }

  nearestChest(position) {
    let nearest = null;
    for (const chest of this.chests.values()) {
      const distance = chestDistance(position, chest);
      if (!nearest || distance < nearest.distance) nearest = { chest, distance };
    }
    return nearest;
  }

  result() {
    const histogram = values => Object.fromEntries([...new Set(values)].map(v => [String(v), values.filter(other => other === v).length]));
    return { version: this.version, captureEnded: this.complete, replayFinished: this.lastHud?.state === 'finished', endReason: this.endReason,
      lastHud: this.lastHud, replayTime: { firstSec: this.timings.firstSec, lastSec: this.timings.lastSec,
        speeds: [...this.timings.hudSpeeds], epochs: [...this.timings.epochs], resolution: 'Last observed HUD second; packet order retained.' },
      observedPacketCounts: this.counts, undecodableFrames: this.decodeErrors,
      health: { metadataKey: this.legacy ? 6 : 9, sampleCount: this.healthSamples.length,
        fractionalSamples: this.healthSamples.filter(s => !Number.isInteger(s.health)).length,
        lossChanges: this.healthChanges.filter(s => s.healthLoss > 0).length,
        healingChanges: this.healthChanges.filter(s => s.healing > 0).length,
        samples: this.healthSamples, changes: this.healthChanges,
        caution: 'Observed health deltas only. Deaths without a final health update and absorption require separate handling; no attacker assignment.' },
      damageEvents: this.damageEvents, hurtAnimations: this.hurts,
      resources: { collections: this.collections, spawnCount: this.resourceSpawns.length,
        unresolvedCollections: this.unresolvedCollections,
        pickupCount: this.resourcePickups.length, pickupQuantityHistogram: histogram(this.resourcePickups.map(p => p.packetCount)),
        metadataQuantityHistogram: histogram(this.resourcePickups.map(p => p.metadataCount)),
        quantityDisagreements: this.resourcePickups.filter(p => p.packetCount !== null && p.packetCount !== p.metadataCount),
        spawns: this.resourceSpawns, pickups: this.resourcePickups,
        caution: 'Pickup packets and item snapshots are evidence, not verified carried/credited totals. Throws and kill-transfer deduplication remain unvalidated.' },
      enderChests: this.replayChests, chestVisits: this.chestVisits, chunkErrors: this.chunkErrors, deaths: this.deaths };
  }
}
