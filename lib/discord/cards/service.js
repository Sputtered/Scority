import {createHash} from 'node:crypto';
import {AttachmentBuilder} from 'discord.js';
import {AvatarCache} from './avatars.js';
import {renderPlayerCard,renderGameCard,renderMatchupCard,renderLeaderboardCard,STYLES} from './render.js';
import {playerStats,gameMatchups} from '../stats.js';
import {gameLabel} from '../store.js';
import {metricName} from '../theme.js';
import {EXTENDED_STATS} from '../../stat-fields.js';
import {gameSnapshot} from './snapshot.js';

function playerSnapshot(player) {
  const values=Object.fromEntries(['name','games','wins','losses','kills','deaths','kd','wl','finalKills','bedBreaks','winrate',...EXTENDED_STATS,'newStatsGames'].map(key=>[key,player[key]]));
  return {...values,history:player.history.map(({outcome})=>({outcome}))};
}
const keepFields=new Set(['Rescore','Game voided','Name links','Names need a fix','Names to check','Please check','DM update','My note','Replay ID','Replay']);

export class ImageCards {
  constructor({store,style='inventory',playerStyle=style,gameStyle=style,avatars=new AvatarCache(),submitterName=async()=>null,now=()=>Date.now(),log=console.error}={}) {
    for (const value of [style,playerStyle,gameStyle]) if(value!=='off' && !STYLES[value])throw new Error(`Unknown card style: ${value}. Choose inventory, carbon, arena, studio, or off.`);
    this.store=store;this.style=style;this.playerStyle=playerStyle;this.gameStyle=gameStyle;this.avatars=avatars;this.submitterName=submitterName;this.now=now;this.log=log;
    this.cache=new Map();this.pending=new Map();
  }
  async image(kind,data,style) {
    const key=createHash('sha256').update(JSON.stringify({kind,style,data})).digest('hex');
    const cached=this.cache.get(key);if(cached?.expires>this.now())return cached.buffer;
    if(this.pending.has(key))return this.pending.get(key);
    const work=(async()=>{
      const names=kind==='leaderboard'?(data.metric==='submissions'?[]:data.rows.map(p=>p.name)):kind==='player'?[data.name]:kind==='matchups'?[data.name,...data.opponents.map(p=>p.name)]:Object.keys(data.payload.players);
      const avatars=await this.avatars.many(names);
      const buffer=await (kind==='leaderboard'?renderLeaderboardCard(data,{style,avatars}):kind==='player'?renderPlayerCard(data,{style,avatars}):kind==='matchups'?renderMatchupCard(data,{style,avatars}):renderGameCard(data,{style,avatars}));
      if(buffer.length>7*1024*1024)throw new Error('Card is too large to attach');
      if(this.cache.size>=32)this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key,{buffer,expires:this.now()+5*60_000});return buffer;
    })().finally(()=>this.pending.delete(key));
    this.pending.set(key,work);return work;
  }
  async submissionName(id) {
    let timer;
    try {
      const name=await Promise.race([Promise.resolve().then(()=>this.submitterName(id)),new Promise(resolve=>{timer=setTimeout(()=>resolve(null),2500);})]);
      return typeof name==='string' && name.trim()?name.replace(/[\r\n]/g,' ').slice(0,32):`User ${id.slice(-6)}`;
    } catch { return `User ${id.slice(-6)}`; }
    finally { clearTimeout(timer); }
  }
  async gameAttachment(game) {
    const buffer=await this.image('game',gameSnapshot(game),this.gameStyle==='off'?'inventory':this.gameStyle);
    return new AttachmentBuilder(buffer,{name:`game-${gameLabel(game.id)}.png`,description:`${gameLabel(game.id)} game results`});
  }
  async decorate(payload,view=payload.cardView) {
    if(!view || !payload.embeds?.length)return payload;
    const style=view.kind==='leaderboard'?this.style:view.kind==='player'?this.playerStyle:this.gameStyle;if(style==='off')return payload;
    try {
      let data,ref;
      if(view.kind==='leaderboard') {
        data={metric:view.metric,minimum:view.minimum,rows:await Promise.all(view.rows.map(async p=>({...p,name:p.user_id?await this.submissionName(p.user_id):p.name})))};
        ref=view.token;
      } else if(view.kind==='player') {
        data=playerSnapshot(playerStats(this.store.games(),view.name));ref=data.name;
      } else {
        const game=view.game || this.store.findGame(view.ref);
        if(!game || game.payload.nameLinks?.excludedFromStats)return payload;
        data=view.kind==='matchups'?gameMatchups(game,view.name):gameSnapshot(game);ref=gameLabel(game.id);
      }
      // freeze stats before fetching avatars
      const buffer=await this.image(view.kind,data,style);
      const name=view.kind==='leaderboard'?`leaderboard-${data.metric}.png`:view.kind==='player'?`stats-${data.name}.png`:view.kind==='matchups'?`matchups-${ref}-${data.name}.png`:`game-${ref}.png`;
      const components=payload.components.map(row=>({...row,components:[...row.components]}));
      const control={type:2,style:2,label:'Show text',custom_id:`rp:${view.user}:${view.kind==='leaderboard'?'textranking':view.kind==='player'?'textstats':view.kind==='matchups'?'textmatchups':'textgame'}:${ref}${view.kind==='matchups'?`,${view.name}`:''}`};
      const actions=components.find(row=>row.components.some(button=>['All games','Download results','View results','Game results'].includes(button.label)));
      if(actions && actions.components.length<5)actions.components.push(control);
      else if(components.length<5)components.push({type:1,components:[control]});
      return {...payload,embeds:payload.embeds.map((embed,index)=>index?embed:{...embed,
        ...(view.kind==='leaderboard'?{description:'Choose a list below, or use Show text to read the rankings.'}:{}),
        fields:(embed.fields || []).filter(field=>keepFields.has(field.name)),image:{url:`attachment://${name}`}}),
        components,files:[...(payload.files || []),new AttachmentBuilder(buffer,{name,description:view.kind==='leaderboard'?`Top 10 ${metricName(data.metric)}. Use Show text for the full rankings.`:view.kind==='player'?`${data.name}: ${data.wins} wins, ${data.losses} losses, ${data.kills} kills, ${data.deaths} deaths. Use Show text for all stats.`:view.kind==='matchups'?`${data.name}: kills, deaths and K/D against each opponent in ${ref}. Use Show text for all matchups.`:`${ref} game results. Use Show text for the full scoreboard.`})]};
    } catch(err) {
      this.log(`[discord] Card unavailable, keeping text results: ${err.message}`);return payload;
    }
  }
}
