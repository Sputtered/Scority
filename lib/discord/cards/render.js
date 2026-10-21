import {teamKnown,gameTeams,TEAM_INK} from '../../team-colors.js';
import {renderInventoryGame,renderInventoryPlayer,renderInventoryMatchup} from './inventory.js';
import {createCanvas,GlobalFonts,loadImage} from '@napi-rs/canvas';
import {fileURLToPath} from 'node:url';
import {placeholderAvatar} from './avatars.js';
import {NICK_REMINDER,metricName} from '../theme.js';
import {displayRatio} from '../stats.js';
import {statNumber,visibleStats} from '../../stat-fields.js';
import {upgradeLine} from '../../team-upgrades.js';
import {drawVoidedDiamond} from './item-icons.js';

for (const [file,family] of [['Lato-Regular.ttf','Lato'],['Lato-Bold.ttf','Lato'],['Lato-Black.ttf','Lato'],['BarlowCondensed-SemiBold.ttf','Barlow Condensed'],['BarlowCondensed-Bold.ttf','Barlow Condensed']]) {
  if (!GlobalFonts.registerFromPath(fileURLToPath(new URL(`../../../assets/fonts/${file}`,import.meta.url)),family)) {
    throw new Error(`Could not load card font ${file}`);
  }
}
export const STYLES={
  inventory:{label:'Inventory',bg:'#0d1217',panel:'#182026',line:'#738087',ink:'#f0f4f5',muted:'#9ba6af',yellow:'#ffdc57',red:'#ff9393',green:'#80dca4',aqua:'#7ff2f2',radius:3,display:'Lato'},
  carbon:{label:'Carbon',bg:'#101216',panel:'#1a1d23',line:'#2b3038',ink:'#f6f6f3',muted:'#a3aab5',yellow:'#ffda57',red:'#ff8684',green:'#84dbaa',aqua:'#7ff2f2',radius:20,display:'Lato'},
  arena:{label:'Arena',bg:'#101410',panel:'#1b211b',line:'#374035',ink:'#f8f9ed',muted:'#b0b8a9',yellow:'#f4ed64',red:'#ff9890',green:'#a2e8aa',aqua:'#7ff2f2',radius:5,display:'Barlow Condensed'},
  studio:{label:'Studio Carbon',bg:'#151616',panel:'#222323',line:'#363834',ink:'#f2ead8',muted:'#aaa99f',yellow:'#eed58b',red:'#df9992',green:'#a5cbb0',aqua:'#7ff2f2',radius:14,display:'Lato'},
};
for(const style of Object.values(STYLES))for(const [team,color]of Object.entries(TEAM_INK))style[team]??=color;
const fallback=placeholderAvatar();
const logo=await loadImage(fileURLToPath(new URL('../../../assets/branding/scority-logo.webp',import.meta.url)));
const num=value=>Number.isFinite(value)?new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(value):'0';
function rounded(ctx,x,y,w,h,r,fill,stroke=null) {
  ctx.beginPath();ctx.roundRect(x,y,w,h,r);ctx.fillStyle=fill;ctx.fill();
  if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=1;ctx.stroke();}
}
function text(ctx,value,x,y,size,color,{weight=500,font='Lato',max=1000,align='left'}={}) {
  weight=Math.round(weight/100)*100;
  let content=String(value);ctx.font=`${weight} ${size}px "${font}"`;
  while(ctx.measureText(content).width>max && size>13){size--;ctx.font=`${weight} ${size}px "${font}"`;}
  if(ctx.measureText(content).width>max){while(content && ctx.measureText(`${content}…`).width>max)content=content.slice(0,-1);content+='…';}
  ctx.fillStyle=color;ctx.textAlign=align;ctx.textBaseline='top';ctx.fillText(content,x,y);ctx.textAlign='left';
}
function line(ctx,x,y,w,color){ctx.fillStyle=color;ctx.fillRect(x,y,w,1);}
function badge(ctx,label,x,y,fill,ink,width=130) {
  rounded(ctx,x,y,width,32,5,fill);text(ctx,label,x+width/2,y+7,14,ink,{weight:750,align:'center',max:width-12});
}
function avatar(ctx,name,images,x,y,size,s) {
  ctx.save();ctx.beginPath();ctx.roundRect(x,y,size,size,s.radius===5?2:10);ctx.clip();
  ctx.imageSmoothingEnabled=false;ctx.drawImage(images.get(String(name).toLowerCase()) || fallback,x,y,size,size);ctx.restore();
}
function base(style,height,kind,sample) {
  const s=STYLES[style];if(!s)throw new Error('Unknown card style');
  const W=style==='studio'?1280:1120,pad=style==='studio'?40:48;
  const canvas=createCanvas(W,height),ctx=canvas.getContext('2d');ctx.fillStyle=s.bg;ctx.fillRect(0,0,W,height);
  if(style==='arena') {
    ctx.save();ctx.globalAlpha=.045;ctx.strokeStyle=s.yellow;ctx.lineWidth=1;
    for(let i=-height;i<W;i+=40){ctx.beginPath();ctx.moveTo(i,0);ctx.lineTo(i+height,height);ctx.stroke();}ctx.restore();
    ctx.fillStyle=s.yellow;ctx.fillRect(0,0,12,height);
  } else if(style==='carbon' || style==='studio') {
    const glow=ctx.createRadialGradient(980,30,0,980,30,450);glow.addColorStop(0,'#ffda5712');glow.addColorStop(1,'#ffda5700');ctx.fillStyle=glow;ctx.fillRect(0,0,W,height);
  }
  ctx.drawImage(logo,pad,28,40,40);
  text(ctx,'SCORITY',pad+53,40,18,s.ink,{weight:750});
  text(ctx,kind,W-pad,43,14,s.muted,{weight:600,align:'right'});
  line(ctx,pad,height-56,W-pad*2,s.line);
  text(ctx,NICK_REMINDER,pad,height-34,15,s.muted);
  text(ctx,sample?'SAMPLE DATA':'SCORITY',W-pad,height-34,13,s.muted,{weight:650,align:'right'});
  return {canvas,ctx,s};
}
function metric(ctx,s,label,value,x,y,w,{highlight=false,large=false,height=large?142:102,voidIcon=false}={}) {
  rounded(ctx,x,y,w,height,s.radius,highlight?s.yellow:s.panel,highlight?null:s.line);
  const ink=highlight?'#1d211c':s.ink,muted=highlight?'#424637':s.muted;
  if(voidIcon)drawVoidedDiamond(ctx,x+20,y+14,28);
  text(ctx,label.toUpperCase(),x+(voidIcon?58:24),y+(height<102?14:20),15,muted,{weight:650,max:w-(voidIcon?78:48)});
  text(ctx,statNumber(value),x+24,y+(large?47:height<102?39:44),large?(height<142?54:66):height<102?34:36,ink,{weight:700,font:s.display,max:w-48});
}
function recent(ctx,s,p,x,y) {
  text(ctx,'RECENT RESULTS',x,y,14,s.muted,{weight:650});
  const results=(p.history || []).filter(h=>h.outcome==='win' || h.outcome==='loss').slice(0,10);
  if(!results.length)text(ctx,'No results yet',x+172,y,15,s.muted);
  results.forEach((h,i)=>{
    rounded(ctx,x+172+i*42,y-4,32,28,s.radius===5?2:6,h.outcome==='win'?s.green:s.red);
    text(ctx,h.outcome==='win'?'W':'L',x+188+i*42,y+1,13,s.bg,{weight:750,align:'center'});
  });
}
export async function renderPlayerCard(p,{style='inventory',avatars=new Map(),sample=false}={}) {
  if(style==='inventory')return renderInventoryPlayer(p,{avatars,sample});
  const {canvas,ctx,s}=base(style,778,'PLAYER STATS',sample);
  const width=canvas.width,pad=style==='studio'?40:48,gap=16,left=248,right=pad+left+28,available=width-pad-right;
  rounded(ctx,pad,100,left,256,s.radius,s.panel,s.line);
  avatar(ctx,p.name,avatars,pad+76,116,96,s);
  text(ctx,p.name,pad+left/2,229,27,s.ink,{weight:750,align:'center',max:left-28});
  text(ctx,`${num(p.games)} ${p.games===1?'game':'games'} played`,pad+left/2,270,16,s.muted,{align:'center'});
  text(ctx,`${num(p.winrate)}% win rate`,pad+left/2,310,24,s.yellow,{weight:700,align:'center',max:left-24});
  const top=[['Wins',p.wins],['Losses',p.losses],['K/D',p.kd],['W/L',p.wl]];
  const col=(available-gap*3)/4;
  top.forEach(([label,value],i)=>metric(ctx,s,label,value,right+i*(col+gap),100,col,{height:116,highlight:i===0}));
  [['Kills',p.kills],['Deaths',p.deaths],['Finals',p.finalKills],['Beds',p.bedBreaks]].forEach(([label,value],i)=>
    metric(ctx,s,label,value,right+i*(col+gap),238,col,{height:118}));
  const statWidth=(width-pad*2-gap*2)/3;
  [['DIAMONDS',p.diamondsCollected],['DIAMONDS VOIDED',p.diamondsVoided],['EMERALDS',p.emeraldsCollected]]
    .forEach(([label,value],i)=>metric(ctx,s,label,value,pad+i*(statWidth+gap),390,statWidth,{height:118,voidIcon:i===1}));
  const damageWidth=(width-pad*2-gap)/2;
  [['DAMAGE DEALT / HP',p.damageDealt],['DAMAGE RECEIVED / HP',p.damageReceived]]
    .forEach(([label,value],i)=>metric(ctx,s,label,Number.isFinite(value)?Math.round(value):null,pad+i*(damageWidth+gap),528,damageWidth,{height:118}));
  text(ctx,`ASSISTS  ${statNumber(p.assists)}`,pad,678,20,s.ink,{weight:700});
  return canvas.encode('png');
}

export async function renderLeaderboardCard(board,{style='studio',avatars=new Map(),sample=false}={}) {
  const {canvas,ctx,s}=base(style,720,'LEADERBOARD',sample);
  const width=canvas.width,pad=style==='studio'?40:48,gap=24,col=(width-pad*2-gap)/2;
  const submissions=board.metric==='submissions',rows=board.rows.slice(0,10);
  text(ctx,metricName(board.metric).toUpperCase(),pad,96,38,s.ink,{weight:750,font:s.display,max:width-300});
  text(ctx,submissions?'Most replays submitted':`Minecraft players · ${board.minimum || 1}+ games played`,pad,145,17,s.muted);
  text(ctx,'TOP 10',width-pad,96,42,s.yellow,{weight:750,align:'right'});
  for(let i=0;i<10;i++) {
    const x=pad+Math.floor(i/5)*(col+gap),y=192+(i%5)*86,p=rows[i];
    rounded(ctx,x,y,col,74,s.radius,p && i===0?'#333126':s.panel,p && i===0?s.yellow:s.line);
    const medal=[s.yellow,'#c4cbd0','#c6a586'][i] || s.muted;
    text(ctx,String(i+1).padStart(2,'0'),x+18,y+25,19,p?medal:s.line,{weight:750});
    if(!p) {
      text(ctx,'Spot open',x+64,y+25,20,s.muted);
      continue;
    }
    if(submissions) {
      rounded(ctx,x+60,y+13,48,48,10,s.line);
      text(ctx,(p.name || '?').slice(0,1).toUpperCase(),x+84,y+23,25,s.yellow,{weight:750,align:'center',max:36});
    } else avatar(ctx,p.name,avatars,x+60,y+13,48,s);
    text(ctx,p.name || `User ${p.user_id}`,x+124,y+15,23,s.ink,{weight:700,max:col-258});
    text(ctx,submissions?`ID ${p.user_id}`:`${num(p.games)} games played`,x+124,y+45,13,s.muted,{max:col-260});
    text(ctx,submissions?num(p.value):displayRatio(p.value),x+col-20,y+14,30,i<3?s.yellow:s.ink,{weight:750,align:'right',max:110});
    text(ctx,submissions?'REPLAYS':board.metric==='kd'?'K/D':'W/L',x+col-20,y+48,12,s.muted,{weight:700,align:'right'});
  }
  text(ctx,!rows.length?'No scores yet. Submit a replay to get started.':submissions?'Unique submissions · Invalid and voided replays do not count':'Ratios use 1 when deaths or losses are 0.',pad,638,14,s.muted);
  return canvas.encode('png');
}

function teamTable(ctx,s,players,{x,y,width,title,color,outcome,avatars,originals,compact=false}) {
  const header=96,step=116;
  const h=header+Math.max(1,players.length)*step;
  rounded(ctx,x,y,width,h,s.radius,s.panel,s.line);
  rounded(ctx,x+20,y+22,5,24,2,color);
  text(ctx,title,x+38,y+21,23,s.ink,{weight:700,font:s.display});
  if(outcome)badge(ctx,outcome,x+width-96,y+17,outcome==='WIN'?color:s.line,outcome==='WIN'?s.bg:s.muted,76);
  const cols=[width-202,width-145,width-88,width-32];
  text(ctx,'PLAYER',x+20,y+62,12,s.muted,{weight:650});
  ['K','D','F','B'].forEach((label,i)=>text(ctx,label,x+cols[i],y+62,13,s.muted,{weight:650,align:'right'}));
  line(ctx,x+20,y+82,width-40,s.line);
  if(!players.length)text(ctx,'No players recorded',x+20,y+126,17,s.muted);
  players.forEach(([name,stats],index)=>{
    const ry=y+header+3+index*step;
    avatar(ctx,name,avatars,x+20,ry,38,s);
    const original=originals.get(name.toLowerCase());
    text(ctx,name,x+71,ry+(original?0:7),20,s.ink,{weight:650,max:width-300});
    if(original)text(ctx,`as ${original}`,x+71,ry+25,13,s.muted,{max:width-300});
    [stats.kills,stats.deaths,stats.finalKills,stats.bedBreaks].forEach((value,i)=>text(ctx,num(value),x+cols[i],ry+6,22,i===0?color:s.ink,{weight:650,font:s.display,align:'right',max:45}));
    const cell=(width-40)/4;
    [['ASSISTS',stats.assists],['DIAMONDS',stats.diamondsCollected],['VOIDED',stats.diamondsVoided],['EMERALDS',stats.emeraldsCollected]].forEach(([label,value],i)=>{
      const sx=x+20+cell*i;
      if(i===2)drawVoidedDiamond(ctx,sx,ry+45,18);
      text(ctx,label,sx+(i===2?23:0),ry+49,10,s.muted,{weight:700,max:cell-8-(i===2?23:0)});
      text(ctx,statNumber(value),sx,ry+66,22,i===0?'#83d7eb':s.green,{weight:700,max:cell-8});
    });
    if(index<players.length-1)line(ctx,x+20,ry+109,width-40,s.line);
  });
  return h;
}
export async function renderGameCard(game,{style='inventory',avatars=new Map(),sample=false}={}) {
  if(style==='inventory')return renderInventoryGame(game,{avatars,sample});
  if(game.payload.nameLinks?.excludedFromStats)throw new Error('Name conflicts need review before rendering a score card');
  const p=game.payload;
  const grouped=team=>Object.entries(p.players).filter(([,stats])=>(teamKnown(stats.team)?stats.team:null)===team).map(([name,stats])=>[name,visibleStats(stats,p.tracking)]).sort((a,b)=>b[1].kills-a[1].kills || a[0].localeCompare(b[0]));
  const sides=gameTeams(p),unknown=grouped(null),rows=Math.max(...sides.map(team=>grouped(team).length),1);
  if(Math.max(rows,unknown.length)>16)throw new Error('Use the text scoreboard for large teams');
  const compact=style==='studio',pad=compact?40:48,width=compact?1280:1120;
  const tableY=compact?176:226,header=96,step=116;
  const tableHeight=header+rows*step,extra=unknown.length?header+24+unknown.length*step:0;
  const gridRows=Math.ceil(sides.length/2),stride=tableHeight+90;
  const height=tableY+gridRows*stride+extra+74;
  const {canvas,ctx,s}=base(style,height,'GAME RESULTS',sample);
  const winner=p.match.winner,known=!p.match.voided && teamKnown(winner);
  text(ctx,p.match.voided?'GAME VOIDED':known?`${winner.toUpperCase()} TEAM WINS`:'RESULT PENDING',pad,compact?88:100,style==='arena'?68:compact?40:45,p.match.voided?s.red:s.ink,{font:s.display,weight:750,max:830});
  const duration=Number.isFinite(p.match.totalDurationSec)?`${Math.floor(p.match.totalDurationSec/60)}:${String(Math.floor(p.match.totalDurationSec%60)).padStart(2,'0')}`:'Length not recorded';
  text(ctx,`G${String(game.id).padStart(5,'0')}   /   ${duration}   /   ${Object.keys(p.players).length} players`,pad,compact?140:style==='arena'?184:170,17,s.muted);
  const originals=new Map((p.nameLinks?.assignments || []).filter(e=>e.original.toLowerCase()!==e.main.toLowerCase()).map(e=>[e.main.toLowerCase(),e.original]));
  const teams=sides.toSorted((a,b)=>(b===winner)-(a===winner)).map(team=>[team,grouped(team)]);
  teams.forEach(([team,players],i)=>teamTable(ctx,s,players,{x:pad+(i%2)*(compact?612:524),y:tableY+Math.floor(i/2)*stride,width:compact?588:500,title:`${team.toUpperCase()} TEAM`,color:s[team],outcome:known?team===winner?'WIN':'LOSS':null,avatars,originals,compact}));
  if(unknown.length)teamTable(ctx,s,unknown,{x:pad,y:tableY+gridRows*stride,width:width-pad*2,title:'TEAM NOT RECORDED',color:s.muted,avatars,originals,compact});
  teams.forEach(([team],i)=>{
    const x=pad+(i%2)*(compact?612:524),y=tableY+Math.floor(i/2)*stride+tableHeight+18;
    text(ctx,`${team.toUpperCase()} UPGRADES / EST. ACQUIRED BY`,x,y,12,s[team]);
    text(ctx,upgradeLine(p.teamUpgrades,team),x,y+23,15,s.ink,{max:compact?588:500});
  });
  text(ctx,'\u2014 Not recorded',pad,height-88,13,s.muted);
  text(ctx,p.match.voided?'Not counted in stats':game.winner_reviewed?'Result checked by me':'Result scored by the bot',width-pad,height-94,14,s.muted,{align:'right'});
  return canvas.encode('png');
}

export async function renderMatchupCard(matchup,{style='studio',avatars=new Map(),sample=false}={}) {
  if(matchup.opponents.length>16)throw new Error('Use text results for this many opponents');
  if(style==='inventory')return renderInventoryMatchup(matchup,{avatars,sample});
  const width=style==='studio'?1280:1120,pad=style==='studio'?40:48;
  const left=style==='studio'?272:244,right=pad+left+32,tableWidth=width-pad-right;
  const header=60,step=68,tableY=136,tableHeight=header+Math.max(1,matchup.opponents.length)*step;
  const height=Math.max(560,tableY+tableHeight+92);
  const {canvas,ctx,s}=base(style,height,'GAME MATCHUPS',sample);
  const center=pad+left/2;
  rounded(ctx,pad,96,left,392,s.radius,s.panel,s.line);
  rounded(ctx,center-58,112,116,116,14,s.yellow);
  avatar(ctx,matchup.name,avatars,center-52,118,104,s);
  text(ctx,matchup.name,center,245,29,s.ink,{weight:750,align:'center',max:left-32});
  text(ctx,`${matchup.team.toUpperCase()} TEAM`,center,286,15,s[matchup.team],{weight:650,align:'center'});
  line(ctx,pad+24,322,left-48,s.line);
  text(ctx,`${num(matchup.kills)} / ${num(matchup.deaths)} / ${statNumber(matchup.assists)}`,center,344,44,s.ink,{weight:750,align:'center',max:left-32});
  text(ctx,'KILLS / DEATHS / ASSISTS',center,400,12,s.muted,{weight:650,align:'center',max:left-24});
  text(ctx,`${num(matchup.kd)} K/D`,center,435,25,s.yellow,{weight:700,align:'center'});
  drawVoidedDiamond(ctx,pad+24,458,20);text(ctx,`${statNumber(matchup.diamondsVoided)} diamonds voided`,pad+54,460,13,s.muted,{max:left-70});
  text(ctx,`G${String(matchup.gameId).padStart(5,'0')} · THIS GAME ONLY`,right,99,20,s.ink,{weight:700});
  rounded(ctx,right,tableY,tableWidth,tableHeight,s.radius,s.panel,s.line);
  const cols=[tableWidth-320,tableWidth-220,tableWidth-120,tableWidth-35];
  text(ctx,'OPPONENT',right+24,tableY+22,14,s.muted,{weight:650});
  ['KILLS','DEATHS','ASSISTS','K/D'].forEach((label,i)=>text(ctx,label,right+cols[i],tableY+22,14,s.muted,{weight:650,align:'right'}));
  line(ctx,right+24,tableY+header-6,tableWidth-48,s.line);
  if(!matchup.opponents.length)text(ctx,'No opponents recorded',right+24,tableY+header+18,18,s.muted);
  matchup.opponents.forEach((opponent,index)=>{
    const y=tableY+header+index*step+12;
    avatar(ctx,opponent.name,avatars,right+24,y,38,s);
    text(ctx,opponent.name,right+78,y+8,21,s.ink,{weight:650,max:tableWidth-420});
    [opponent.kills,opponent.deaths,opponent.assists,opponent.kd].forEach((value,i)=>text(ctx,statNumber(value),right+cols[i],y+6,26,i===3?s.yellow:s.ink,{weight:650,align:'right',max:100}));
    if(index<matchup.opponents.length-1)line(ctx,right+24,y+step-8,tableWidth-48,s.line);
  });
  text(ctx,'Only kills between these players count.',right,height-82,15,s.muted);
  return canvas.encode('png');
}
