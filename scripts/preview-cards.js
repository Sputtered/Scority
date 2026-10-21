import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createCanvas,loadImage} from '@napi-rs/canvas';
import {STYLES,renderPlayerCard,renderGameCard,renderMatchupCard,renderLeaderboardCard} from '../lib/discord/cards/render.js';
import {AvatarCache} from '../lib/discord/cards/avatars.js';
import {gameMatchups} from '../lib/discord/stats.js';

const output=fileURLToPath(new URL('../previews/cards/',import.meta.url));
await mkdir(output,{recursive:true});
const player={name:'Sputtered',games:36,wins:27,losses:9,winrate:75,kills:236,deaths:90,wl:3,finalKills:44,bedBreaks:18,
  kd:2.62,damageReceived:4820.5,damageDealt:3912.5,diamondsCollected:173,emeraldsCollected:61,damageDealtConfidence:.78,
  newStatsGames:{damageReceived:24,damageDealt:24,diamondsCollected:24,emeraldsCollected:24},damageAccuracy:null,
  history:['win','win','loss','win','win','win','loss','win','win','win'].map(outcome=>({outcome}))};
const roster=[['Sputtered','red',18,8,2,1],['Technoblade','red',12,9,1,0],['Notch','red',9,11,1,0],['jeb_','red',7,6,0,0],
  ['Mikowa','green',16,12,1,0],['Dream','green',9,13,1,1],['GeorgeNotFound','green',6,10,0,0],['Sapnap','green',3,11,0,0]];
const game={id:42,winner_reviewed:false,payload:{match:{winner:'red',totalDurationSec:514},
  tracking:{status:'tracked',damageCoverage:.65},
  players:Object.fromEntries(roster.map(([name,team,kills,deaths,finalKills,bedBreaks],i)=>[name,{team,kills,deaths,finalKills,bedBreaks,
    damageReceived:100+i*13.5,damageDealt:80+i*8.2,diamondsCollected:2+i,emeraldsCollected:i%3,damageDealtConfidence:.78}]))}};
game.payload.killFeed=[];
const matrices=[[[7,5,4,2],[3,3,3,3],[1,3,2,3],[1,2,1,3]],[[3,4,6,3],[2,3,2,2],[2,1,2,1],[1,1,1,0]]];
for(let team=0;team<2;team++)for(let killer=0;killer<4;killer++)for(let victim=0;victim<4;victim++) {
  for(let n=0;n<matrices[team][killer][victim];n++)game.payload.killFeed.push({killer:roster[team*4+killer][0],victim:roster[(1-team)*4+victim][0]});
}
const names=[...roster.map(row=>row[0]),'Dinnerbone','Grumm'];
const cache=new AvatarCache({timeout:8000});const avatars=await cache.many(names);
const status=Object.fromEntries([...avatars].map(([name,image])=>[name,image?'Minecraft avatar loaded':'Generic placeholder: avatar unavailable']));
console.log(JSON.stringify(status,null,2));
const sheets=[];
for(const style of Object.keys(STYLES)) {
  for(const metric of ['kd','wl','submissions']) {
    const rows=names.map((name,i)=>({name:metric==='submissions'?`ReplayFan${i+1}`:name,
      ...(metric==='submissions'?{user_id:String(100000000000000000n+BigInt(i))}:{}),
      games:36-i,value:metric==='submissions'?87-i*6:Math.round((4.83-i*.37)*100)/100}));
    await writeFile(`${output}${style}-leaderboard-${metric}.png`,await renderLeaderboardCard({metric,minimum:1,rows},{style,avatars,sample:true}));
  }
  const profile=await renderPlayerCard(player,{style,avatars,sample:true});
  const result=await renderGameCard(game,{style,avatars,sample:true});
  await writeFile(`${output}${style}-matchups.png`,await renderMatchupCard(gameMatchups(game,'Sputtered'),{style,avatars,sample:true}));
  await writeFile(`${output}${style}-player.png`,profile);await writeFile(`${output}${style}-game.png`,result);
  sheets.push({style,profile:await loadImage(profile),result:await loadImage(result)});
}
const rowHeights=sheets.map(({profile,result})=>Math.ceil(Math.max(profile.height*724/profile.width,result.height*724/result.width))+118);
const canvas=createCanvas(1568,150+rowHeights.reduce((a,b)=>a+b,0)),ctx=canvas.getContext('2d');ctx.fillStyle='#090b0f';ctx.fillRect(0,0,canvas.width,canvas.height);
ctx.fillStyle='#f4f3ed';ctx.font='700 34px Lato';ctx.fillText('SCORITY / THREE DIRECTIONS',40,56);
ctx.fillStyle='#a3aab5';ctx.font='18px Lato';ctx.fillText('Same sample stats. Real Minecraft avatars where available. Pick a style or mix your favorite parts.',40,88);
sheets.forEach(({style,profile,result},index)=>{
  const top=130+rowHeights.slice(0,index).reduce((a,b)=>a+b,0);
  ctx.fillStyle='#ffda57';ctx.font='700 27px Lato';ctx.fillText(`${'ABC'[index]} / ${STYLES[style].label}`,40,top+30);
  ctx.fillStyle='#a3aab5';ctx.font='15px Lato';ctx.fillText('PLAYER STATS',40,top+60);ctx.fillText('GAME RESULTS',804,top+60);
  ctx.drawImage(profile,40,top+78,724,profile.height*724/profile.width);
  ctx.drawImage(result,804,top+78,724,result.height*724/result.width);
});
await writeFile(`${output}comparison.png`,await canvas.encode('png'));
await writeFile(`${output}avatar-status.json`,JSON.stringify(status,null,2)+'\n');
console.log(`Saved eighteen cards and comparison.png in ${output}`);
