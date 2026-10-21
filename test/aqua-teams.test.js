import test from 'node:test';
import assert from 'node:assert/strict';
import {makeTeamResolver,gameTeams} from '../lib/team-colors.js';
import {parseMessage} from '../lib/death-parser.js';
import {Match} from '../lib/match.js';
import {createCaptureMatch,scorePacket} from '../lib/capture-scoring.js';
import {inferTeamUpgrades} from '../lib/team-upgrades.js';
import {ReplayStore,ADMIN_ID} from '../lib/discord/store.js';
import {gameMatchups,playerStats,matchup} from '../lib/discord/stats.js';
import {DiscordUI} from '../lib/discord/ui.js';
import {RecorderBridge} from '../lib/discord/recorder.js';
import {createInteractionHandler} from '../lib/discord/interactions.js';
import {recentComponents} from '../lib/discord/recent-controls.js';
import {gameCardFingerprint} from '../lib/discord/cards/snapshot.js';
import {renderGameCard,renderMatchupCard,STYLES} from '../lib/discord/cards/render.js';
import {commands} from '../lib/discord/commands.js';
import {loadImage} from '@napi-rs/canvas';
import {game} from './fixtures/discord-game.js';

const aquaGame=()=>{const p=game({bobTeam:'aqua',winner:'aqua'});p.bedBreaks[0].team='aqua';return p;};
function storeFor(t,p=aquaGame()) {const store=new ReplayStore(':memory:');t.after(()=>store.close());store.importGame(p);return store;}

test('Aqua colors resolve in JSON chat, legacy chat and RGB; Red/Green remains supported',()=>{
  const resolve=makeTeamResolver();
  for(const color of ['aqua','dark_aqua','#55FFFF','#00AAAA'])assert.equal(resolve(color),'aqua');
  assert.equal(resolve('green'),'green');assert.equal(resolve('dark_red'),'red');
  for(const component of ['§cRedPlayer §7was killed by §bAquaPlayer§7. FINAL KILL!',
    {text:'',extra:[{text:'RedPlayer',color:'dark_red'},{text:' was killed by '},{text:'AquaPlayer',color:'dark_aqua'},{text:'. FINAL KILL!'}]}]){
    const match=new Match({onlyRecordWhilePlaying:false});match.handleParsedMessage(parseMessage(component));
    const p=match.toJSON();assert.equal(p.players.AquaPlayer.team,'aqua');assert.equal(p.match.winner,'aqua');
    assert.deepEqual(p.teams,{red:['RedPlayer'],aqua:['AquaPlayer'],unassigned:[]});
  }
  const bed=parseMessage('BED DESTRUCTION > Aqua Bed was destroyed by §cRedPlayer§r!');
  assert.equal(bed.team,'aqua');assert.equal(bed.breakerColor,'red');
});

test('eliminating either side selects the other actual team, including uncredited final voids',()=>{
  for(const eliminated of ['red','aqua']){
    const match=new Match({onlyRecordWhilePlaying:false});
    match._setTeamIfColored('Survivor',eliminated==='red'?'aqua':'red');
    for(let i=0;i<4;i++)match.handleParsedMessage(parseMessage(`${eliminated==='red'?'§c':'§b'}Player${i} §7fell into the void. FINAL KILL!`));
    assert.equal(match.toJSON().match.winner,eliminated==='red'?'aqua':'red');
    assert.equal(match.toJSON().match.winReason,'elimination');
  }
});

test('packet scoring detects Aqua without chat and credits melee plus the remaining HP on a void kill',()=>{
  const match=createCaptureMatch('1.8.9','aqua-fixture');let sequence=0;
  match.updateActionBar({state:'playing',elapsedSec:0,totalSec:600,speed:1});
  const packet=(name,data)=>scorePacket(match,{type:'packet',name,data,sequence:sequence++,receivedMs:1000});
  for(const [id,name,prefix,z]of [[1,'RedPlayer','§c',0],[2,'AquaPlayer','§3',2]]){
    packet('player_info',{data:[{UUID:name,name}]});packet('scoreboard_team',{team:name,mode:0,prefix,players:[name]});
    packet('named_entity_spawn',{entityId:id,playerUUID:name,x:0,y:2048,z:z*32,yaw:128,pitch:0});
    packet('entity_metadata',{entityId:id,metadata:[{key:6,value:20}]});
  }
  assert.equal(match.toJSON().players.AquaPlayer.team,'aqua');
  match.updateActionBar({state:'playing',elapsedSec:1,totalSec:600,speed:1});
  packet('animation',{entityId:2,animation:0});packet('entity_status',{entityId:1,entityStatus:2});
  packet('entity_metadata',{entityId:1,metadata:[{key:6,value:16}]});
  match.updateActionBar({state:'playing',elapsedSec:2,totalSec:600,speed:1});
  packet('entity_teleport',{entityId:1,x:0,y:-320,z:0});
  packet('chat',{position:0,message:JSON.stringify({text:'§cRedPlayer §7was thrown into the void by §bAquaPlayer§7. FINAL KILL!'})});
  match.updateActionBar({state:'finished',elapsedSec:2,totalSec:600,speed:1});
  const p=match.toJSON();assert.equal(p.match.winner,'aqua');
  assert.equal(p.players.AquaPlayer.damageDealt,20);assert.equal(p.players.RedPlayer.damageReceived,20);
  assert.deepEqual(p.players.AquaPlayer.damageByOpponent.RedPlayer,{dealt:20,received:0});
  assert.deepEqual(Object.keys(p.teamUpgrades.teams),['red','aqua']);
});

test('Aqua upgrade evidence is attributed to Aqua and does not create a Green timeline',()=>{
  const hits=[1,2].map(sequence=>({sequence,t:sequence+10,healthLoss:3.7352,
    armor:['leather_helmet','leather_chestplate','iron_leggings','iron_boots'],sword:'stone_sword',team:'c',attackerTeam:'b',epoch:1}));
  const r=inferTeamUpgrades(hits);assert.equal(r.teams.aqua.sharpness.status,'estimated');
  assert.equal(r.teams.red.protection1.status,'estimated');assert.equal(r.teams.green,undefined);
  assert.deepEqual(Object.keys(inferTeamUpgrades([],{teamNames:['c','3'],status:'incomplete'}).teams),['red','aqua']);
});

test('Aqua counts in wins, rival statistics, player matchups and public player buttons',async t=>{
  const store=storeFor(t),saved=store.getGame(1),ui=new DiscordUI(store,new RecorderBridge(store,{log:()=>{}}));
  assert.equal(playerStats(store.games(),'Mikowa').wins,1);assert.equal(playerStats(store.games(),'Sputtered').losses,1);
  assert.equal(matchup(store.games(),'Mikowa','Sputtered').wins,1);
  assert.equal(gameMatchups(saved,'Mikowa').opponents[0].name,'Sputtered');
  const result=ui.render(ADMIN_ID,'replay',{replay:'G1'}),text=JSON.stringify(result.embeds);
  assert.match(text,/Aqua team wins/);assert.match(text,/Aqua: SHARP/);assert.doesNotMatch(text,/Green/);
  const customId=recentComponents(saved).flatMap(r=>r.components).find(c=>c.label==='Mikowa').custom_id;
  const press={user:{id:ADMIN_ID},customId,isChatInputCommand:()=>false,isAutocomplete:()=>false,isButton:()=>true,isStringSelectMenu:()=>false,isModalSubmit:()=>false,
    async deferReply(options){this.deferred=true;this.flags=options.flags;},async editReply(payload){this.payload=payload;}};
  await createInteractionHandler({store,ui,log:()=>{}})(press);
  assert.equal(press.flags,64);assert.match(JSON.stringify(press.payload),/Mikowa · Aqua/);assert.match(JSON.stringify(press.payload.embeds),/vs Sputtered/);
});

test('admin saves Aqua teams, beds, upgrades and winner, refreshes the card snapshot, and can undo',t=>{
  const store=storeFor(t,game()),before=gameCardFingerprint(store.getGame(1));let edit=store.gameEditor(1);
  edit.draft.players[1].team='aqua';edit.draft.winner='aqua';edit.draft.bedBreaks[0].team='aqua';edit.draft.upgrades.aqua.sharpness=120;
  edit=store.saveGameEditor(ADMIN_ID,1,edit.version,edit.draft);
  assert.equal(edit.game.payload.players.Mikowa.team,'aqua');assert.deepEqual(gameTeams(edit.game.payload),['red','aqua']);
  assert.equal(edit.game.payload.bedBreaks[0].team,'aqua');assert.equal(edit.game.payload.teamUpgrades.teams.aqua.sharpness.bySec,120);
  assert.notEqual(gameCardFingerprint(edit.game),before);assert.equal(playerStats(store.games(),'Mikowa').wins,1);
  store.restoreGameEditor(ADMIN_ID,1,edit.version,edit.history[0].id);assert.equal(store.getGame(1).payload.players.Mikowa.team,'green');
  store.setWinner(ADMIN_ID,'G1','aqua');assert.equal(store.getGame(1).payload.match.winner,'aqua');
  assert.ok(commands.find(c=>c.name==='setwinner').options.find(o=>o.name==='team').choices.some(c=>c.value==='aqua'));
});

test('all card styles render Red/Aqua with two team panels and render Aqua player details',async t=>{
  const store=storeFor(t),aqua=store.getGame(1),green=structuredClone(aqua);
  green.payload.match.winner='green';green.payload.players.Mikowa.team='green';
  for(const style of Object.keys(STYLES)){
    const a=await renderGameCard(aqua,{style}),g=await renderGameCard(green,{style});
    const ai=await loadImage(a),gi=await loadImage(g);assert.deepEqual([ai.width,ai.height],[gi.width,gi.height]);assert.ok(!a.equals(g));
    assert.ok((await renderMatchupCard(gameMatchups(aqua,'Mikowa'),{style})).length>10000);
  }
});
