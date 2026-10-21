import test from 'node:test';
import assert from 'node:assert/strict';
import {mergePlayerDamage} from '../lib/discord/damage-backfill.js';
import {PLAYER_DAMAGE_VERSION} from '../lib/player-damage.js';
import {damageTracked} from '../lib/stat-fields.js';
import {game} from './fixtures/discord-game.js';
function fixture(){
  const original=game(),scored=structuredClone(original);original.match.replayId='fixture';scored.match.replayId='fixture';scored.match.endReason='replay_finished';
  Object.assign(scored.players.Sputtered,{damageDealt:12,damageReceived:3,damageByOpponent:{Mikowa:{dealt:12,received:3}}});
  Object.assign(scored.players.Mikowa,{damageDealt:3,damageReceived:12,damageByOpponent:{Sputtered:{dealt:3,received:12}}});
  scored.tracking={status:'tracked',damage:{version:PLAYER_DAMAGE_VERSION,status:'tracked',scope:'attributed-player-damage'},damageEvents:[]};
  return {original,scored};
}
test('damage backfill preserves all other saved statistics and does not mutate its input',()=>{
  const {original,scored}=fixture(),snapshot=structuredClone(original);scored.players.Sputtered.kills=999;
  const result=mergePlayerDamage(original,scored);assert.deepEqual(original,snapshot);
  assert.equal(result.players.Sputtered.kills,original.players.Sputtered.kills);assert.equal(result.players.Sputtered.damageDealt,12);
  assert.deepEqual(result.killFeed,original.killFeed);assert.deepEqual(result.match,original.match);
});
test('version 2 damage backfills version 1 games while both remain readable',()=>{
  const {original,scored}=fixture();
  original.tracking={status:'tracked',damage:{version:1,status:'tracked',scope:'attributed-player-damage'}};
  const result=mergePlayerDamage(original,scored);
  assert.equal(result.tracking.damage.version,2);
  assert.equal(original.tracking.damage.version,1);
  assert.equal(damageTracked(original.tracking),true);assert.equal(damageTracked(result.tracking),true);
});
test('backfill rejects wrong replay, roster, incomplete captures and inconsistent totals',()=>{
  for(const mutation of [s=>s.match.replayId='wrong',s=>delete s.players.Mikowa,s=>s.match.endReason='interrupted',
    s=>s.players.Sputtered.damageReceived=999,s=>s.players.Mikowa.team='red',s=>s.players.Sputtered.damageByOpponent.Mikowa.dealt=-1]){
    const {original,scored}=fixture();mutation(scored);assert.throws(()=>mergePlayerDamage(original,scored));
  }
});
