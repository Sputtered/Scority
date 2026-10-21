import {ITEM_STATS} from './stat-fields.js';

export const ITEM_USAGE_VERSION = 1;
export const ITEM_USAGE_FIELDS = ITEM_STATS;

const gearFields = {iron_sword:'ironSwordLives', golden_pickaxe:'goldenPickaxeLives', iron_axe:'ironAxeLives', milk_bucket:'milkBucketLives'};
const key = name => String(name ?? '').toLowerCase();
const validName = name => typeof name === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(name);
const empty = value => Object.fromEntries(ITEM_USAGE_FIELDS.map(field => [field, value]));

// observed usage; only deaths close lives
export class ItemUsage {
  constructor(version) {
    this.version = version;
    this.supported = version === '1.8.9';
    this.players = new Map();
    this.entities = new Map();
    this.events = [];
    this.issues = new Set();
  }

  player(name) {
    if (!validName(name)) return null;
    const id = key(name);
    if (!this.players.has(id)) this.players.set(id, {
      name, counts:empty(0), seen:new Set(), life:1, closed:false, deadGenerations:new Set()
    });
    return this.players.get(id);
  }

  item(value, registry) {
    if (value === null || value?.blockId === -1 || value?.itemCount === 0) return null;
    const id = typeof value === 'number' ? value : value?.itemId ?? value?.blockId;
    if (id === 0 || id === -1) return null;
    return registry.items[id]?.name;
  }

  entity(entity, registry) {
    if (!this.entities.has(entity.generation)) this.entities.set(entity.generation, {
      generation:entity.generation,
      held:this.item(entity.spawnData?.currentItem, registry),
      pendingTools:new Set(), pendingApples:[], player:null
    });
    return this.entities.get(entity.generation);
  }

  credit(player, field, row) {
    if (field !== 'goldenApplesEaten') {
      if (player.seen.has(field)) return;
      player.seen.add(field);
    }
    player.counts[field]++;
    this.events.push({player:player.name, field, life:player.life, sequence:row.sequence,
      replaySec:row.replay?.elapsedSec ?? null});
  }

  observe(row, world) {
    if (!this.supported || row.type !== 'packet') return;
    const {name, data} = row;
    const playing = row.replay?.state === 'playing';
    const entity = world.entities.get(data.entityId);
    if (entity?.kind === 'player' && name === 'entity_equipment' && data.slot === 0) {
      const state = this.entity(entity, world.registry);
      state.held = this.item(data.item, world.registry);
      if (playing && state.held === undefined) this.issues.add('A held-item update could not be decoded.');
    }
    // paused setup cannot count as usage
    for (const candidate of world.entities.values()) {
      if (candidate.kind !== 'player') continue;
      const state = this.entity(candidate, world.registry);
      if (!playing) continue;
      const player = this.player(world.playerName(candidate));
      if (player) {
        state.player = player;
        // cleanup health resets cannot reopen lives
        if (player.deadGenerations.has(candidate.generation)) continue;
        if (player.closed) {
          player.closed = false;
          player.life++;
          player.seen.clear();
        }
        for (const field of state.pendingTools) this.credit(player, field, row);
        for (const event of state.pendingApples) this.credit(player, 'goldenApplesEaten', event);
        state.pendingTools.clear();
        state.pendingApples.length = 0;
      }
      const field = gearFields[state.held];
      if (field) {
        if (player) this.credit(player, field, row);
        else state.pendingTools.add(field);
      }
    }
    if (!playing || name !== 'entity_status' || data.entityStatus !== 9) return;
    if (entity?.kind !== 'player') {
      this.issues.add('A completed item use had no matching player entity.');
      return;
    }
    const state = this.entity(entity, world.registry);
    if (state.player?.closed || state.player?.deadGenerations.has(entity.generation)) return;
    if (state.held === undefined) {
      this.issues.add('A completed item use had no known held item.');
    } else if (state.held === 'golden_apple') {
      if (state.player) this.credit(state.player, 'goldenApplesEaten', row);
      else state.pendingApples.push(row);
    }
  }

  recordDeath(death, world) {
    if (!this.supported) return;
    const player = this.player(death.victim);
    if (!player || player.closed) return;
    player.closed = true;
    for (const entity of world.entities.values()) {
      if (entity.kind !== 'player' || key(world.playerName(entity)) !== key(death.victim)) continue;
      player.deadGenerations.add(entity.generation);
      const state = this.entity(entity, world.registry);
      state.held = undefined;
      state.pendingTools.clear();
      state.pendingApples.length = 0;
    }
  }

  result({finished, started, invalid, decodeErrors = false, names = []}) {
    const unresolved = [...this.entities.values()].some(state => !state.player &&
      (state.pendingTools.size || state.pendingApples.length));
    let status = 'tracked', reason = null;
    if (!this.supported) {status = 'unsupported'; reason = 'Item usage is supported for 1.8.9 replay recordings only.';}
    else if (invalid) {status = 'invalid'; reason = 'Replay navigation or an invalid recording prevents complete item counts.';}
    else if (!started || !finished) {status = 'incomplete'; reason = 'A complete recording from the beginning is required.';}
    else if (decodeErrors || this.issues.size || unresolved) {
      status = 'unavailable';
      reason = decodeErrors ? 'Some playback packets could not be decoded.' :
        unresolved ? 'Some item observations could not be assigned to a player.' : [...this.issues][0];
    } else if (!names.length) {status = 'unavailable'; reason = 'No players were observed during playback.';}
    const players = Object.fromEntries(names.map(name => [name, status === 'tracked' ?
      {...(this.players.get(key(name))?.counts ?? empty(0))} : empty(null)]));
    return {players, tracking:{version:ITEM_USAGE_VERSION, status, scope:'observed-item-use',
      rule:'Golden apples count completed item-use status packets while holding a golden apple. Each tool and milk bucket count once per recorded life in which they were seen held.',
      lifeRule:'Recorded death closes a life; a fresh player spawn starts the next life, including reused entity IDs. Visibility reloads alone and health resets do not start lives.',
      reason, issues:[...this.issues]}, events:status === 'tracked' ? this.events : []};
  }
}
