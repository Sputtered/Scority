import {teamKnown,gameTeams,TEAM_INK,TEAM_WOOL} from '../../team-colors.js';
import {createCanvas,loadImage,GlobalFonts} from '@napi-rs/canvas';
import {fileURLToPath} from 'node:url';
import {placeholderAvatar} from './avatars.js';
import {UPGRADE_COLUMNS,upgradeTime} from '../../team-upgrades.js';
import {visibleStats,damageNumber,assistsTracked} from '../../stat-fields.js';
import {drawVoidedDiamond} from './item-icons.js';
import {drawItemUsage,itemUsageWidth} from './item-usage-icons.js';

const asset=name=>fileURLToPath(new URL(`../../../assets/${name}`,import.meta.url));
for(const weight of ['Regular','Bold','Black'])GlobalFonts.registerFromPath(asset(`fonts/Lato-${weight}.ttf`),'Lato');
const logo=await loadImage(asset('branding/scority-logo.webp')),fallback=placeholderAvatar(),textures={};
for(const name of ['stonebrick','obsidian','diamond_block','emerald_block','wool_colored_red','wool_colored_lime','wool_colored_cyan','wool_colored_blue','wool_colored_yellow','wool_colored_white','wool_colored_pink','wool_colored_gray','diamond','emerald','diamond_sword','iron_sword','bone','bed','ascii','arrow','skull'])textures[name]=await loadImage(asset(`minecraft/${name}.png`));
const ink='#f0f4f5',muted='#9ba6af',green='#80dca4',red='#ff9393';
const metrics=[['Kills','kills','iron_sword'],['Deaths','deaths','skull'],['Finals','finalKills','diamond_sword'],['Beds','bedBreaks','bed'],['Diamonds','diamondsCollected','diamond'],['Voided','diamondsVoided','diamond_void'],['Emeralds','emeraldsCollected','emerald']];
const damageMetrics=[['Dealt','damageDealt'],['Received','damageReceived']];
const hp=damageNumber;
function text(ctx,value,x,y,size=20,color=ink,{align='left',max=1000}={}){
  let content=String(value);ctx.font=`700 ${size}px Lato`;
  while(ctx.measureText(content).width>max && size>12)ctx.font=`700 ${--size}px Lato`;
  while(ctx.measureText(content).width>max && content.length>1){content=content.slice(0,-2)+'…';}
  ctx.fillStyle=color;ctx.textAlign=align;ctx.textBaseline='middle';ctx.fillText(content,x,y);ctx.textAlign='left';
  return ctx.measureText(content).width;
}
function rect(ctx,x,y,w,h,color){ctx.fillStyle=color;ctx.fillRect(x,y,w,h);}
function tile(ctx,name,x,y,w,h,{size=64,shade=0}={}){
  ctx.save();ctx.beginPath();ctx.rect(x,y,w,h);ctx.clip();ctx.imageSmoothingEnabled=false;
  for(let a=x;a<x+w;a+=size)for(let b=y;b<y+h;b+=size)ctx.drawImage(textures[name],a,b,size,size);
  ctx.globalAlpha=shade;rect(ctx,x,y,w,h,'#050809');ctx.restore();
}
function icon(ctx,name,x,y,size){if(name==='diamond_void')return drawVoidedDiamond(ctx,x,y,size);ctx.save();ctx.imageSmoothingEnabled=false;ctx.drawImage(textures[name],x,y,size,size);ctx.restore();}
function head(ctx,name,avatars,x,y,size){ctx.save();ctx.imageSmoothingEnabled=false;ctx.drawImage(avatars.get(name.toLowerCase())||avatars.get(name)||fallback,x,y,size,size);ctx.restore();}
function bevel(ctx,x,y,w,h){rect(ctx,x,y,w,h,'#182026');rect(ctx,x,y,w,3,'#738087');rect(ctx,x,y,3,h,'#738087');rect(ctx,x,y+h-4,w,4,'#05080b');rect(ctx,x+w-4,y,4,h,'#05080b');}
const ascii=createCanvas(128,128),actx=ascii.getContext('2d');actx.drawImage(textures.ascii,0,0,128,128);const pixels=actx.getImageData(0,0,128,128).data;
const glyphs=new Map(),tinted=new Map();
for(let code=32;code<127;code++){let end=0;for(let x=0;x<8;x++)for(let y=0;y<8;y++)if(pixels[(((code>>4)*8+y)*128+(code%16)*8+x)*4+3])end=Math.max(end,x+1);glyphs.set(code,code===32?3:end||5);}
function bitmap(ctx,value,x,y,scale=3,color=ink,{align='left',max=1408}={}){
  const chars=[...String(value)].map(c=>glyphs.has(c.charCodeAt(0))?c.charCodeAt(0):45);
  const units=chars.reduce((n,c)=>n+(glyphs.get(c)+1),0);scale=Math.max(1,Math.min(scale,Math.floor(max/units)));const width=units*scale;
  if(align==='center')x-=width/2;if(align==='right')x-=width;
  const atlas=col=>{if(!tinted.has(col)){const canvas=createCanvas(128,128),g=canvas.getContext('2d');g.drawImage(ascii,0,0);g.globalCompositeOperation='source-in';rect(g,0,0,128,128,col);tinted.set(col,canvas);}return tinted.get(col);};
  ctx.save();ctx.imageSmoothingEnabled=false;
  for(const code of chars){for(const [glyphColor,offset]of [['#081015',scale],[color,0]])ctx.drawImage(atlas(glyphColor),(code%16)*8,(code>>4)*8,8,8,Math.round(x)+offset,y+offset,8*scale,8*scale);x+=(glyphs.get(code)+1)*scale;}ctx.restore();
}
const number=value=>Number.isFinite(value)?new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(value):'-';
function base(height,kind,sample){const canvas=createCanvas(1408,height),ctx=canvas.getContext('2d');rect(ctx,0,0,1408,height,'#0d1217');ctx.drawImage(logo,40,31,40,40);text(ctx,'SCORITY',94,52,22);text(ctx,sample?`${kind} / SAMPLE`:kind,1368,52,14,muted,{align:'right'});return{canvas,ctx};}

export async function renderInventoryGame(game,{avatars=new Map(),sample=false}={}){
  const p=game.payload;
  if(p.nameLinks?.excludedFromStats)throw new Error('Name conflicts need review before rendering a score card');
  const known=!p.match.voided && teamKnown(p.match.winner),winner=known?p.match.winner:null;
  const sides=gameTeams(p);
  if(sides.length>2)return renderPublicInventoryGame(game,{avatars,sample});
  const teams=[...(sides.length===2 && sides[0]==='red' && ['green','aqua'].includes(sides[1])?(winner==='red'?sides:sides.toReversed()):sides.toSorted((a,b)=>(b===winner)-(a===winner))),null].map(team=>({team,players:Object.entries(p.players).filter(([,player])=>(teamKnown(player.team)?player.team:null)===team).sort((a,b)=>b[1].kills-a[1].kills||a[0].localeCompare(b[0]))})).filter(g=>g.team || g.players.length);
  if(teams.some(g=>g.players.length>16))throw new Error('Use text results for large teams');
  const height=162+teams.reduce((n,g)=>n+118+Math.max(1,g.players.length)*64+(g.team?88:0)+24,0)+50;
  const{canvas,ctx}=base(height,'GAME RESULTS',sample);tile(ctx,'stonebrick',0,85,1408,height-85,{size:96,shade:.85});
  bitmap(ctx,p.match.voided?'GAME VOIDED':winner?`${winner.toUpperCase()} TEAM WINS`:'RESULT PENDING',40,101,4,TEAM_INK[winner] || ink,{max:940});
  const duration=Number.isFinite(p.match.totalDurationSec)?`${Math.floor(p.match.totalDurationSec/60)}:${String(p.match.totalDurationSec%60).padStart(2,'0')}`:'—';
  text(ctx,`G${String(game.id).padStart(5,'0')} / ${duration} / ${Object.keys(p.players).length} PLAYERS`,1364,117,16,muted,{align:'right'});
  const originals=new Map((p.nameLinks?.assignments||[]).filter(n=>n.original.toLowerCase()!==n.main.toLowerCase()).map(n=>[n.main.toLowerCase(),n.original]));
  const columns=[...metrics,...damageMetrics];if(assistsTracked(p.tracking))columns.splice(2,0,['Assists','assists','arrow']);
  const start=528,cw=Math.floor(836/columns.length);let y=162;
  for(const group of teams){
    const rosterHeight=118+Math.max(1,group.players.length)*64,h=rosterHeight+(group.team?88:0);bevel(ctx,32,y,1344,h);
    tile(ctx,group.team?`wool_colored_${TEAM_WOOL[group.team]}`:'stonebrick',36,y+4,1336,48,{size:64,shade:.5});
    bitmap(ctx,group.team?`${group.team.toUpperCase()} TEAM`:'TEAM NOT RECORDED',58,y+15,3);
    if(winner && group.team)bitmap(ctx,group.team===winner?'WIN':'LOSS',1346,y+15,3,ink,{align:'right'});
    text(ctx,'PLAYER',58,y+84,13,muted);
    columns.forEach(([label,,ico],i)=>{
      const cx=start+i*cw;
      if(ico){const short=cw<100?({Diamonds:'DMD',Emeralds:'EMR'}[label]||label):label;icon(ctx,ico,cx+4,y+66,24);text(ctx,short.toUpperCase(),cx+32,y+79,11,ink,{max:cw-34});}
      else {text(ctx,label.toUpperCase(),cx+(cw-8)/2,y+74,12,ink,{align:'center'});text(ctx,'PvP / HP',cx+(cw-8)/2,y+93,11,muted,{align:'center'});}
    });
    if(!group.players.length)text(ctx,'No players recorded',58,y+134,20,muted);
    group.players.forEach(([name,stats],index)=>{
      const ry=y+104+index*64;bevel(ctx,50,ry,456,58);head(ctx,name,avatars,60,ry+10,36);const original=originals.get(name.toLowerCase());
      text(ctx,name,109,ry+(original?19:29),21,ink,{max:217});if(original)text(ctx,`as ${original}`,109,ry+42,12,muted,{max:217});
      const shown=visibleStats(stats,p.tracking);
      drawItemUsage(ctx,shown,340,ry+15);
      columns.forEach(([,key],i)=>{const cx=start+i*cw;bevel(ctx,cx,ry,cw-8,58);tile(ctx,key==='diamondsCollected'?'diamond_block':key==='emeraldsCollected'?'emerald_block':'obsidian',cx+4,ry+4,cw-16,50,{size:48,shade:key.endsWith('Collected')?.47:.6});bitmap(ctx,key.startsWith('damage')?hp(shown[key]):number(shown[key]),cx+(cw-8)/2,ry+18,3,key==='damageDealt'?'#ffdc57':key==='damageReceived'?'#b5dafa':ink,{align:'center',max:cw-26});});
    });
    if(group.team){
      const uy=y+rosterHeight+4;
      icon(ctx,'iron_sword',60,uy+14,30);bitmap(ctx,'TEAM UPGRADES',109,uy+13,2,ink,{max:270});
      text(ctx,'EST. ACQUIRED BY',109,uy+46,12,muted);
      UPGRADE_COLUMNS.forEach(([key,label],i)=>{
        const ux=408+i*177;bevel(ctx,ux,uy,169,66);
        text(ctx,label,ux+84,uy+17,12,muted,{align:'center'});
        bitmap(ctx,upgradeTime(p.teamUpgrades?.teams?.[group.team]?.[key]),ux+84,uy+33,3,ink,{align:'center',max:145});
      });
    }
    y+=h+24;
  }
  text(ctx,'PvP damage / HP   |   2 HP = 1 heart',40,height-29,17,muted);
  text(ctx,'- Not recorded',1368,height-29,15,muted,{align:'right'});
  return canvas.encode('png');
}

async function renderPublicInventoryGame(game,{avatars,sample}){
  const p=game.payload,winner=!p.match.voided&&teamKnown(p.match.winner)?p.match.winner:null;
  const sides=gameTeams(p).toSorted((a,b)=>(b===winner)-(a===winner));
  const groups=[...sides,null].map(team=>({team,players:Object.entries(p.players).filter(([,v])=>(teamKnown(v.team)?v.team:null)===team)
    .sort((a,b)=>b[1].kills-a[1].kills||a[0].localeCompare(b[0]))})).filter(g=>g.team||g.players.length);
  if(groups.some(g=>g.players.length>16))throw new Error('Use text results for large teams');
  const heights=[];for(let i=0;i<groups.length;i+=2)heights.push(144+Math.max(1,...groups.slice(i,i+2).map(g=>g.players.length))*100);
  const height=162+heights.reduce((n,h)=>n+h+24,0)+56,{canvas,ctx}=base(height,'GAME RESULTS',sample);
  tile(ctx,'stonebrick',0,85,1408,height-85,{size:96,shade:.85});
  bitmap(ctx,p.match.voided?'GAME VOIDED':winner?`${winner.toUpperCase()} TEAM WINS`:'RESULT PENDING',40,101,4,TEAM_INK[winner]||ink,{max:850});
  const duration=`${Math.floor(p.match.totalDurationSec/60)}:${String(Math.floor(p.match.totalDurationSec%60)).padStart(2,'0')}`;
  text(ctx,`G${String(game.id).padStart(5,'0')} / ${duration} / ${Object.keys(p.players).length} PLAYERS`,1368,117,16,muted,{align:'right'});
  const columns=[['K','kills'],['D','deaths'],['A','assists'],['FK','finalKills'],['BED','bedBreaks'],['DMD','diamondsCollected'],['VOID','diamondsVoided'],['EMR','emeraldsCollected'],['DEALT','damageDealt'],['RECV','damageReceived']];
  const originals=new Map((p.nameLinks?.assignments||[]).filter(n=>n.original.toLowerCase()!==n.main.toLowerCase()).map(n=>[n.main.toLowerCase(),n.original]));
  let y=162;
  for(let i=0;i<groups.length;i+=2){
    const h=heights[i/2];
    for(let col=0;col<2;col++){
      const group=groups[i+col];if(!group)continue;const x=32+col*684,w=660;
      bevel(ctx,x,y,w,h);tile(ctx,group.team?`wool_colored_${TEAM_WOOL[group.team]}`:'stonebrick',x+4,y+4,w-8,44,{size:64,shade:.5});
      bitmap(ctx,group.team?`${group.team.toUpperCase()} TEAM`:'UNASSIGNED',x+20,y+14,3,ink,{max:460});
      if(winner&&group.team)bitmap(ctx,group.team===winner?'WIN':'LOSS',x+w-20,y+14,3,ink,{align:'right'});
      group.players.forEach(([name,stats],row)=>{
        const ry=y+58+row*100,shown=visibleStats(stats,p.tracking),original=originals.get(name.toLowerCase());
        head(ctx,name,avatars,x+18,ry,28);
        const nameWidth=text(ctx,name,x+57,ry+14,20,ink,{max:original?235:410});
        drawItemUsage(ctx,shown,x+57+nameWidth+16,ry+1,{size:24,pitch:30});
        if(original)text(ctx,`as ${original}`,x+w-18,ry+14,12,muted,{align:'right',max:160});
        columns.forEach(([label,key],n)=>{
          const sx=x+16+n*63;bevel(ctx,sx,ry+37,58,52);
          const ico={kills:'iron_sword',deaths:'skull',assists:'arrow',finalKills:'diamond_sword',diamondsVoided:'diamond_void'}[key];
          if(ico){icon(ctx,ico,sx+3,ry+40,17);text(ctx,label,sx+39,ry+49,10,muted,{align:'center'});}else text(ctx,label,sx+29,ry+49,10,muted,{align:'center'});
          bitmap(ctx,key.startsWith('damage')?hp(shown[key]):number(shown[key]),sx+29,ry+65,2,key==='damageDealt'?'#ffdc57':key==='damageReceived'?'#b5dafa':ink,{align:'center',max:52});
        });
      });
      if(!group.players.length)text(ctx,'No players recorded',x+20,y+80,18,muted);
      const uy=y+h-72;text(ctx,'UPGRADES / EST. ACQUIRED BY',x+20,uy,11,muted);
      UPGRADE_COLUMNS.forEach(([key,label],n)=>{
        const sx=x+20+n*126;text(ctx,label,sx,uy+21,10,muted);
        bitmap(ctx,upgradeTime(p.teamUpgrades?.teams?.[group.team]?.[key]),sx,uy+34,2,ink,{max:113});
      });
    }
    y+=h+24;
  }
  text(ctx,'A = Assists  |  DMD = Diamonds  |  VOID = Diamonds voided  |  EMR = Emeralds  |  Damage / HP',40,height-31,15,muted);
  text(ctx,'- Not recorded',1368,height-31,15,muted,{align:'right'});
  return canvas.encode('png');
}

export async function renderInventoryPlayer(p,{avatars=new Map(),sample=false}={}){
  const{canvas,ctx}=base(782,'PLAYER STATS',sample);tile(ctx,'stonebrick',0,87,1408,695,{size:64,shade:.87});
  const itemStyle={size:32,pitch:null};
  head(ctx,p.name,avatars,40,115,96);const nameWidth=text(ctx,p.name,160,144,34,ink,{max:Math.min(750,1000-itemUsageWidth(p,itemStyle)-24)});
  drawItemUsage(ctx,p,160+nameWidth+24,128,itemStyle);
  text(ctx,`${number(p.games)} ${p.games===1?'GAME':'GAMES'}`,160,185,14,muted);
  text(ctx,`${number(p.winrate)}% WIN RATE`,1368,149,17,muted,{align:'right'});
  const small=[['WINS',p.wins],['LOSSES',p.losses],['K/D',p.kd],['W/L',p.wl],['KILLS',p.kills],['DEATHS',p.deaths],['ASSISTS',p.assists],['FINALS',p.finalKills],['BEDS',p.bedBreaks]];
  small.forEach(([label,value],i)=>{const x=40+i*149;bevel(ctx,x,245,133,106);text(ctx,label,x+14,271,13,muted);bitmap(ctx,number(value),x+14,296,4,ink,{max:105});});
  for(const[i,label,value,tex,ico]of [[0,'DIAMONDS',p.diamondsCollected,'diamond_block','diamond'],[1,'DIAMONDS VOIDED',p.diamondsVoided,'obsidian','diamond_void'],[2,'EMERALDS',p.emeraldsCollected,'emerald_block','emerald']]){
    const x=40+i*448,y=385,w=432,h=150;bevel(ctx,x,y,w,h);tile(ctx,tex,x+4,y+4,w-8,h-8,{size:64,shade:.56});icon(ctx,ico,x+22,y+43,64);bitmap(ctx,label,x+106,y+25,3,ink,{max:w-125});bitmap(ctx,number(value),x+106,y+72,6,ink,{max:w-125});
    if(i===1)text(ctx,`${p.newStatsGames?.diamondsVoided??0} of ${number(p.games)} games recorded`,x+106,y+129,12,muted,{max:w-125});
  }
  damageTiles(ctx,p,568);
  text(ctx,`PvP damage / HP   |   ${p.newStatsGames?.damageDealt??0} of ${number(p.games)} games recorded`,40,747,16,muted);
  return canvas.encode('png');
}

function damageTiles(ctx,p,y){
  damageMetrics.forEach(([label,key],i)=>{
    const x=40+i*676;bevel(ctx,x,y,652,138);tile(ctx,'obsidian',x+4,y+4,644,130,{size:64,shade:.72});
    text(ctx,`DAMAGE ${label.toUpperCase()}`,x+26,y+30,17,muted);
    bitmap(ctx,hp(p[key]),x+26,y+67,5,i===0?'#ffdc57':'#b5dafa',{max:360});
    text(ctx,i===0?'To other players / HP':'From other players / HP',x+625,y+106,16,muted,{align:'right'});
  });
}

export async function renderInventoryMatchup(p,{avatars=new Map(),sample=false}={}){
  const height=714+Math.max(1,p.opponents.length)*64;
  const{canvas,ctx}=base(height,'PLAYER GAME STATS',sample);tile(ctx,'stonebrick',0,87,1408,height-87,{size:64,shade:.87});
  head(ctx,p.name,avatars,40,115,96);const nameWidth=text(ctx,p.name,160,144,34,ink,{max:750});
  drawItemUsage(ctx,p,160+nameWidth+24,128,{size:32,pitch:40});
  text(ctx,`G${String(p.gameId).padStart(5,'0')} / THIS GAME / ${p.team.toUpperCase()} TEAM`,160,188,16,muted);
  const detailMetrics=[...metrics];detailMetrics.splice(2,0,['Assists','assists','arrow']);
  detailMetrics.forEach(([label,key,ico],i)=>{
    const x=40+i*168;bevel(ctx,x,242,152,98);icon(ctx,ico,x+12,255,28);text(ctx,label.toUpperCase(),x+48,269,12,muted,{max:100});
    bitmap(ctx,number(p.gameTotals?.[key]??p[key]),x+18,297,4,ink,{max:116});
  });
  damageTiles(ctx,p,372);bitmap(ctx,'OPPONENT BREAKDOWN',40,550,3);
  const cols=[620,730,840,950,1135,1340];
  text(ctx,'OPPONENT',60,611,14,muted);
  ['KILLS','DEATHS','ASSISTS','K/D','DEALT / HP','RECEIVED / HP'].forEach((label,i)=>text(ctx,label,cols[i],611,13,muted,{align:'right'}));
  if(!p.opponents.length)text(ctx,'No opponents recorded',60,660,20,muted);
  p.opponents.forEach((o,i)=>{
    const y=635+i*64;bevel(ctx,40,y,1328,56);head(ctx,o.name,avatars,54,y+10,34);text(ctx,o.name,105,y+28,22,ink,{max:420});
    [number(o.kills),number(o.deaths),number(o.assists),number(o.kd),hp(o.damageDealt),hp(o.damageReceived)].forEach((value,j)=>
      bitmap(ctx,value,cols[j],y+18,3,j===4?'#ffdc57':j===5?'#b5dafa':ink,{align:'right',max:j>=4?150:90}));
  });
  text(ctx,'PvP damage / HP   |   2 HP = 1 heart',40,height-29,17,muted);
  text(ctx,'- Not recorded',1368,height-29,15,muted,{align:'right'});
  return canvas.encode('png');
}
