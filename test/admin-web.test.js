import test from 'node:test';
import assert from 'node:assert/strict';
import {ReplayStore,ADMIN_ID} from '../lib/discord/store.js';
import {playerStats,gameMatchups} from '../lib/discord/stats.js';
import {startAdminServer} from '../lib/web/server.js';
import {ImageCards} from '../lib/discord/cards/service.js';
import {game} from './fixtures/discord-game.js';
import {damageNumber,damageLine} from '../lib/stat-fields.js';
const USER='111111111111111111';
function fixture(t){const store=new ReplayStore(':memory:');t.after(()=>store.close());const job=store.submit(USER,'web-replay');store.claimNext();store.complete(job.id,game());return {store,job};}
test('damage displays whole HP while admin saves preserve precise recorded totals',t=>{
  const store=new ReplayStore(':memory:');t.after(()=>store.close());const p=game();
  p.tracking={status:'valid',damage:{version:1,status:'tracked',scope:'attributed-player-damage'}};
  p.players.Sputtered.damageDealt=296.712345;p.players.Sputtered.damageReceived=197.299999;store.importGame(p);
  const d=store.gameEditor(1);assert.equal(d.draft.players[0].damageDealt,296.712345);
  assert.equal(damageLine(d.draft.players[0]),'297 dealt · 197 received HP');assert.equal(damageNumber(null),'—');
  d.draft.players[0].damageDealt=297;d.draft.players[0].kills=7;
  const saved=store.saveGameEditor(ADMIN_ID,1,d.version,d.draft);
  assert.equal(saved.game.payload.players.Sputtered.damageDealt,296.712345);
  assert.equal(saved.game.payload.players.Sputtered.damageReceived,197.299999);
});
test('admin edits update cards and aggregates while preserving recorded data, names and rescores',async t=>{
  const {store,job}=fixture(t),original=store.db.prepare('SELECT payload FROM games WHERE id=1').get().payload;
  let edit=store.gameEditor(1);edit.draft.players[0].kills=9;edit.draft.players[0].diamondsCollected=17;edit.draft.players[0].emeraldsCollected=3;edit.draft.players[0].name='MainName';edit.draft.winner='green';edit.draft.upgrades.red.protection2=220;
  edit=store.saveGameEditor(ADMIN_ID,1,edit.version,edit.draft);
  assert.equal(store.getGame(1).payload.players.MainName.kills,9);assert.equal(playerStats(store.games(),'MainName').diamondsCollected,17);
  assert.equal(playerStats(store.games(),'MainName').losses,1);assert.equal(edit.game.payload.teamUpgrades.teams.red.protection2.bySec,220);
  assert.equal(store.db.prepare('SELECT payload FROM games WHERE id=1').get().payload,original);
  const cards=new ImageCards({store,avatars:{many:async()=>new Map()}});const first=await cards.image('game',edit.game,'inventory');assert.ok(first.length>10000);
  store.rescore(ADMIN_ID,'G1');store.claimNext();const fresh=game({kills:5});fresh.players.Sputtered.emeraldsCollected=30;store.complete(job.id,fresh);
  assert.equal(store.getGame(1).payload.players.MainName.kills,9);assert.equal(store.getGame(1).payload.players.MainName.emeraldsCollected,3);
  assert.equal(store.quota(USER).used,1);assert.equal(store.games().length,1);
});
test('edits use concurrency checks, roll back invalid values and support audited undo',t=>{
  const {store}=fixture(t),a=store.gameEditor(1),b=store.gameEditor(1);a.draft.players[0].kills=7;a.draft.voided=true;
  const saved=store.saveGameEditor(ADMIN_ID,1,a.version,a.draft);assert.equal(playerStats(store.games(),'Sputtered').games,0);
  assert.throws(()=>store.saveGameEditor(ADMIN_ID,1,b.version,b.draft),/changed while/);
  const bad=structuredClone(saved.draft);bad.players[0].name='OtherName';bad.players[1].deaths=-1;
  assert.throws(()=>store.saveGameEditor(ADMIN_ID,1,saved.version,bad),/whole number/);
  assert.equal(store.getGame(1).payload.players.Sputtered.kills,7);assert.equal(store.gameNames(1).length,0);
  const restored=store.restoreGameEditor(ADMIN_ID,1,saved.version,saved.history[0].id);
  assert.equal(restored.game.voided,false);assert.equal(restored.game.payload.players.Sputtered.kills,2);assert.equal(restored.history.length,2);
  assert.throws(()=>store.saveGameEditor(USER,1,restored.version,restored.draft),/just for me/);
});
test('name conflicts and missing edited players are rejected; event corrections update matchups',t=>{
  const {store,job}=fixture(t);let edit=store.gameEditor(1);edit.draft.players[0].name='Mikowa';
  assert.throws(()=>store.saveGameEditor(ADMIN_ID,1,edit.version,edit.draft),/two players/);
  edit=store.gameEditor(1);edit.draft.players[0].kills=3;edit.draft.killFeed.push({t:300,killer:'Sputtered',victim:'Mikowa',finalKill:false});
  store.saveGameEditor(ADMIN_ID,1,edit.version,edit.draft);assert.equal(gameMatchups(store.getGame(1),'Sputtered').kills,3);
  store.rescore(ADMIN_ID,'G1');store.claimNext();const missing=game();delete missing.players.Sputtered;
  assert.throws(()=>store.complete(job.id,missing),/missing a player with saved stat edits/);
  assert.equal(store.getGame(1).payload.players.Sputtered.kills,3);
});
test('explicit resource corrections remain countable when original tracking was invalid',t=>{
  const store=new ReplayStore(':memory:');t.after(()=>store.close());const p=game();p.tracking={status:'invalid'};p.players.Sputtered.diamondsCollected=2;p.players.Sputtered.emeraldsCollected=5;store.importGame(p);
  let edit=store.gameEditor(1);edit.draft.players[0].diamondsCollected=10;store.saveGameEditor(ADMIN_ID,1,edit.version,edit.draft);
  const stats=playerStats(store.games(),'Sputtered');assert.equal(stats.diamondsCollected,10);assert.equal(stats.emeraldsCollected,null);
});
async function webFixture(t,options={}){
  const {store}=fixture(t);const web=await startAdminServer({store,key:'test-access',port:0,cards:new ImageCards({store,avatars:{many:async()=>new Map()}}),...options});
  // close the listener before storage
  t.after(()=>web.close());
  let cookie='',csrf='';
  const request=async(path,{method='GET',data,headers={}}={})=>{
    const response=await fetch(web.origin+path,{method,headers:{cookie,...(data!==undefined?{'Content-Type':'application/json',Origin:web.origin,'X-CSRF-Token':csrf}:{}),...headers},...(data!==undefined?{body:JSON.stringify(data)}:{})});return response;
  };
  const login=async()=>{const response=await request('/api/login',{method:'POST',data:{key:'test-access'}});cookie=response.headers.get('set-cookie').split(';')[0];csrf=(await response.json()).csrf;return response;};
  return {store,web,request,login};
}
test('all game data, cards and writes require authentication and CSRF; login does not expose keys',async t=>{
  const {request,login}=await webFixture(t);
  for(const path of ['/api/games','/api/players','/api/queue','/api/games/1','/api/games/1/card.png','/api/games/1/export'])assert.equal((await request(path)).status,401);
  assert.equal((await request('/api/login',{method:'POST',data:{key:'test-access'},headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await request('/api/login',{method:'POST',data:{key:'wrong'}})).status,401);
  const response=await login();assert.match(response.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  const edit=await (await request('/api/games/1')).json();edit.draft.players[0].kills=7;
  assert.equal((await request('/api/games/1',{method:'PUT',data:edit,headers:{'X-CSRF-Token':'bad'}})).status,403);
  assert.equal((await request('/api/games/1',{method:'PUT',data:edit})).status,200);
  assert.equal((await request('/api/games/1',{method:'PUT',data:edit})).status,409);
  const card=await request('/api/games/1/card.png');assert.equal(card.status,200);assert.equal(card.headers.get('content-type'),'image/png');assert.ok((await card.arrayBuffer()).byteLength>10000);
  const list=await (await request('/api/games?q=Sputtered')).json();assert.equal(list.total,1);
  const script=await (await request('/app.js')).text();assert.ok(!script.includes('test-access'));
  await request('/api/logout',{method:'POST',data:{}});assert.equal((await request('/api/games')).status,401);
});
test('login rate limiting and session expiry are enforced',async t=>{
  let now=1000;const {request,login}=await webFixture(t,{now:()=>now});await login();now+=9*3600_000;
  assert.equal((await request('/api/games')).status,401);
  for(let i=0;i<8;i++)assert.equal((await request('/api/login',{method:'POST',data:{key:'wrong'}})).status,401);
  assert.equal((await request('/api/login',{method:'POST',data:{key:'test-access'}})).status,429);
  now+=16*60_000;assert.equal((await request('/api/login',{method:'POST',data:{key:'test-access'}})).status,200);
});
test('web rescore and pause use the existing queue without duplicating games',async t=>{
  const {store,request,login}=await webFixture(t);await login();
  assert.equal((await request('/api/queue',{method:'POST',data:{paused:true}})).status,200);assert.equal(store.paused(),true);
  assert.equal((await request('/api/games/1/rescore',{method:'POST',data:{}})).status,200);
  assert.equal((await request('/api/games/1/rescore',{method:'POST',data:{}})).status,409);
  assert.equal(store.games().length,1);assert.equal(store.quota(ADMIN_ID).used,0);
});

test('dashboard settings, commands, jobs, access and names enforce auth and validation',async t=>{
  const {store,request,login}=await webFixture(t);
  for(const path of ['/api/control','/api/jobs','/api/access','/api/names','/api/audit'])assert.equal((await request(path)).status,401);
  await login();const data=await(await request('/api/control')).json();assert.equal(data.runtime.available,false);
  assert.equal((await request('/api/settings',{method:'PUT',data:{version:data.settings.version,values:{'connection.autoRejoin':false}},headers:{'X-CSRF-Token':'bad'}})).status,403);
  assert.equal((await request('/api/settings',{method:'PUT',data:{version:data.settings.version,values:{targetPort:-1}}})).status,400);
  assert.equal((await request('/api/settings',{method:'PUT',data:{version:data.settings.version,values:{'connection.autoRejoin':false}}})).status,200);
  assert.equal((await request('/api/control/commands',{method:'POST',data:{action:'connect'}})).status,503);
  const submitted=await(await request('/api/jobs',{method:'POST',data:{action:'submit',replayId:'dashboard-replay'}})).json();
  assert.equal((await request('/api/jobs',{method:'POST',data:{action:'cancel',id:submitted.job.id}})).status,200);
  assert.equal((await request('/api/jobs',{method:'POST',data:{action:'retry',id:submitted.job.id}})).status,200);
  assert.equal(store.getJob(submitted.job.id).status,'queued');
  assert.equal((await request('/api/access',{method:'POST',data:{action:'priority',id:USER,enabled:true}})).status,200);assert.equal(store.hasPriority(USER),true);
  assert.equal((await request('/api/access',{method:'POST',data:{action:'unlimited',id:USER,enabled:'true'}})).status,400);
  assert.equal((await request('/api/names',{method:'POST',data:{action:'link',alias:'OldName',main:'MainName',kind:'alt'}})).status,200);
  assert.equal((await request('/api/names',{method:'POST',data:{action:'unlink',alias:'OldName',kind:'alt'}})).status,200);
  assert.ok((await(await request('/api/audit')).json()).entries.some(e=>e.action==='bot-settings'));
});
