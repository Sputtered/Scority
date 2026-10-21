import fs from 'node:fs';
import path from 'node:path';
import {STYLES,renderGameCard,renderPlayerCard} from '../lib/discord/cards/render.js';
import {playerStats} from '../lib/discord/stats.js';
const filename=process.argv[2];
if(!filename){console.log('node scripts/preview-scored.js <scored.json> [output-directory]');process.exit(1);}
const payload=JSON.parse(fs.readFileSync(filename,'utf8'));
const output=path.resolve(process.argv[3] || path.join(path.dirname(filename),'cards'));
fs.mkdirSync(output,{recursive:true});
const game={id:1,voided:false,payload};
const name=Object.keys(payload.players).find(n=>n==='Sputtered') || Object.keys(payload.players)[0];
const player=playerStats([game],name);
for(const style of Object.keys(STYLES)) {
  fs.writeFileSync(path.join(output,`${style}-game.png`),await renderGameCard(game,{style}));
  fs.writeFileSync(path.join(output,`${style}-player.png`),await renderPlayerCard(player,{style}));
}
console.log(`Rendered all card styles using the scored replay in ${output}`);
