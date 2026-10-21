import test from 'node:test';
import assert from 'node:assert/strict';
import {TEAM_NAMES,TEAM_COLORS,teamName,gameTeams,makeTeamResolver} from '../lib/team-colors.js';
import {Match} from '../lib/match.js';
import {parseMessage} from '../lib/death-parser.js';
import {createCaptureMatch,scorePacket} from '../lib/capture-scoring.js';
import {inferTeamUpgrades} from '../lib/team-upgrades.js';
import {applyAssists} from '../lib/assists.js';
import {ReplayStore,ADMIN_ID} from '../lib/discord/store.js';
import {DiscordUI} from '../lib/discord/ui.js';
import {RecorderBridge} from '../lib/discord/recorder.js';
import {gameMatchups,playerStats} from '../lib/discord/stats.js';
import {recentComponents} from '../lib/discord/recent-controls.js';
import {renderGameCard,renderMatchupCard,STYLES} from '../lib/discord/cards/render.js';
import {loadImage} from '@napi-rs/canvas';
import {publicGame} from './fixtures/public-game.js';

test('all public teams resolve legacy, named and RGB colors, including Pink and Grey aliases',()=>{
  const r=makeTeamResolver({red:TEAM_COLORS.red,green:TEAM_COLORS.green});
  const codes=['c','9','a','e','b','f','d','8'];
  for(let i=0;i<TEAM_NAMES.length;i++){
    const team=TEAM_NAMES[i];assert.equal(teamName(codes[i]),team);
    assert.equal(r(TEAM_COLORS[team][0]),team);
    const m=new Match({onlyRecordWhilePlaying:false});
    m.handleParsedMessage(parseMessage(`§${codes[i]}Victim §7was killed by §${codes[(i+1)%8]}Killer§7.`));
    assert.equal(m.toJSON().players.Victim.team,team);
    assert.equal(parseMessage(`BED DESTRUCTION > ${team[0].toUpperCase()+team.slice(1)} Bed was destroyed by §cKiller§r!`).team,team);
  }
  assert.equal(r('#FF55FF'),'pink');assert.equal(r('#555555'),'grey');assert.equal(r('#FFFFFF'),'white');assert.equal(teamName('gray'),'grey');
});

test('Doubles, 3s and 4s retain every roster team and detect only the last surviving team',()=>{
  for(const [sides,size]of [[TEAM_NAMES,2],[TEAM_NAMES.slice(0,4),3],[TEAM_NAMES.slice(0,4),4]]){
    const m=new Match({onlyRecordWhilePlaying:false});
    for(const team of sides)for(let n=0;n<size;n++)m._setTeamIfColored(team+n,TEAM_COLORS[team][0]);
    const finish=team=>{for(let n=0;n<size;n++)m.handleParsedMessage({type:'death',victim:team+n,killer:'blue0',finalKill:true,raw:`${team}${n} final`});};
    finish('red');assert.equal(m.toJSON().match.winner,null,'one eliminated team is not a public-game win');
    for(const team of sides.filter(t=>!['red','blue'].includes(t)))finish(team);
    const result=m.toJSON();assert.equal(result.match.winner,'blue');assert.equal(result.match.winReason,'elimination');
    assert.deepEqual(Object.keys(result.teams).filter(t=>t!=='unassigned'),sides);assert.equal(Object.keys(result.players).length,sides.length*size);
  }
});

test('team elimination broadcasts handle disconnects and uncredited final voids in public games',()=>{
  const m=new Match({onlyRecordWhilePlaying:false});
  for(const team of TEAM_NAMES.slice(0,4))m._setTeamIfColored(team+'0',TEAM_COLORS[team][0]);
  for(const team of ['red','blue','green'])m.handleParsedMessage(parseMessage(`TEAM ELIMINATED > ${team[0].toUpperCase()+team.slice(1)} Team has been eliminated!`));
  assert.equal(m.toJSON().match.winner,'yellow');
});

test('packet roster detects 16 public players and upgrade timelines for all eight teams',()=>{
  const m=createCaptureMatch('1.8.9','public-fixture');let sequence=0;
  m.updateActionBar({state:'playing',elapsedSec:0,totalSec:600,speed:1});
  const packet=(name,data)=>scorePacket(m,{type:'packet',name,data,sequence:sequence++,receivedMs:0});
  const codes=['c','9','a','e','b','f','d','8'];let id=0;
  for(const [i,team]of TEAM_NAMES.entries())for(let n=0;n<2;n++){
    const name=team+n;packet('player_info',{data:[{UUID:name,name}]});packet('scoreboard_team',{team:name,mode:0,prefix:'§'+codes[i],players:[name]});
    packet('named_entity_spawn',{entityId:++id,playerUUID:name,x:i*320,y:2048,z:n*32,yaw:0,pitch:0});
  }
  const result=m.toJSON();assert.equal(Object.keys(result.players).length,16);assert.deepEqual(gameTeams(result),TEAM_NAMES);
  assert.deepEqual(Object.keys(result.teamUpgrades.teams),TEAM_NAMES);
  const hits=TEAM_NAMES.flatMap((team,i)=>[1,2].map(n=>({sequence:i*2+n,t:10+n,healthLoss:3.7352,team,attackerTeam:TEAM_NAMES[(i+1)%8],
    armor:['leather_helmet','leather_chestplate','iron_leggings','iron_boots'],sword:'stone_sword',epoch:1})));
  const upgrades=inferTeamUpgrades(hits);for(const team of TEAM_NAMES){assert.equal(upgrades.teams[team].sharpness.status,'estimated');assert.equal(upgrades.teams[team].protection1.status,'estimated');}
});

test('public scoreboards, 16 name buttons, all opponents and owner corrections retain every player',t=>{
  const store=new ReplayStore(':memory:');t.after(()=>store.close());store.importGame(publicGame());
  const ui=new DiscordUI(store,new RecorderBridge(store,{log:()=>{}})),g=store.getGame(1);
  assert.equal(recentComponents(g).flatMap(r=>r.components).length,16);
  assert.equal(gameMatchups(g,'pink0').opponents.length,14);assert.equal(playerStats(store.games(),'pink0').wins,1);
  const payload=ui.render(ADMIN_ID,'replay',{replay:'G1'}),text=JSON.stringify(payload.embeds);
  for(const team of TEAM_NAMES)assert.match(text,new RegExp(team[0].toUpperCase()+team.slice(1)));
  const embed=payload.embeds[0];assert.ok(embed.fields.length<=25);assert.ok(embed.fields.every(f=>f.value.length<=1024));
  assert.ok(embed.fields.reduce((n,f)=>n+f.name.length+f.value.length,embed.title.length+embed.description.length+embed.footer.text.length)<=6000);
  for(const team of TEAM_NAMES){const edit=store.gameEditor(1);edit.draft.winner=team;edit.draft.upgrades[team].sharpness=30;
    assert.equal(store.saveGameEditor(ADMIN_ID,1,edit.version,edit.draft).game.payload.match.winner,team);}
});

test('full public cards and 14-opponent detail fit attachments in every style without dropping teams',async()=>{
  for(const [teams,size]of [[TEAM_NAMES,2],[TEAM_NAMES.slice(0,4),3],[TEAM_NAMES.slice(0,4),4]]){
    const game={id:1,payload:applyAssists(publicGame({teams,size}))};
    for(const style of Object.keys(STYLES)){
      const buffer=await renderGameCard(game,{style}),image=await loadImage(buffer);assert.ok(buffer.length<7*1024*1024);
      assert.ok(image.height<4000);assert.equal(image.width,style==='inventory'?1408:style==='studio'?1280:1120);
    }
    const detail=await renderMatchupCard(gameMatchups(game,teams[0]+'0'),{style:'inventory'});assert.ok(detail.length<7*1024*1024);
  }
});
