import {teamKnown,teamLabel,gameTeams} from '../team-colors.js';
import { randomBytes } from 'node:crypto';
import { escapeMarkdown } from 'discord.js';
import { ADMIN_ID, DAILY_LIMIT, UserError, jobLabel, gameLabel, ign } from './store.js';
import { ADMIN_COMMANDS } from './commands.js';
import { playerStats, playerGames, matchup, gameMatchups, leaderboard, teammates, rivals, displayRatio, countsForStats } from './stats.js';
import { extendedLine, statNumber,damageNumber,damageLine,itemUsageLine,visibleStats } from '../stat-fields.js';
import {upgradeLine} from '../team-upgrades.js';

import { YELLOW, NICK_REMINDER, winLossText, resultText, statusName, metricName, issueText } from './theme.js';
const PAGE_SIZE=5;
const auditName = action => ({rescore:'Rescore requested',rescored:'Game rescored',nolimit:'Daily limit changed',priority:'Priority changed',void:'Game voided',unvoid:'Game restored',whitelist:'User added',unwhitelist:'User removed',resetlimit:'Daily limit reset',submit:'Replay added',cancel:'Replay cancelled',retry:'Replay queued again',pause:'Queue paused',resume:'Queue resumed',setwinner:'Winner changed',namelink:'Name linked',nameunlink:'Name link removed',gamename:'Game name changed',resetname:'Game name reset',namerequest:'Name change requested',nameapprove:'Name change approved',namereject:'Name change rejected'}[action] || 'Update');
function auditDetail(detail) {
  try {
    const d=JSON.parse(detail);
    return [d.target?`User: <@${d.target}>`:null,typeof d.enabled==='boolean'?`Priority: ${d.enabled?'on':'off'}`:null,d.replayId?`Replay: ${safe(d.replayId)}`:null,
      d.id?`Replay: ${gameLabel(d.id)}`:null,d.alias?`Name: ${safe(d.alias)}`:null,d.original?`Original: ${safe(d.original)}`:null,d.main?`Main: ${safe(d.main)}`:null,typeof d.revert==='boolean'?d.revert?'Past links undone':'Past names kept':null,d.team?`Winner: ${safe(d.team)}`:null,d.reason?safe(d.reason):null].filter(Boolean).join(' · ') || 'None';
  } catch { return 'None'; }
}
const safe = value => escapeMarkdown(String(value ?? '')).slice(0,950);
const stamp = value => Number.isFinite(Date.parse(value)) ? `<t:${Math.floor(Date.parse(value)/1000)}:R>` : 'Unknown date';
const stateIcon = {queued:'🕒',recording:'▶️',completed:'✅',failed:'❌',invalid:'❌',cancelled:'➖'};
const field = (name,value,inline=false) => ({name,value:String(value || 'None').slice(0,1024),inline});
const button = (label,custom_id,style=2,disabled=false) => ({type:2,label,custom_id,style:style===1?2:style,disabled});
const row = components => ({type:1,components});
const embed = (title,description='') => ({title,description:description.slice(0,4096),color:YELLOW,fields:[],footer:{text:`Scority · ${NICK_REMINDER}`}});
const gameLine = game => `${game.voided?'⛔ Voided · not counted in stats\n':countsForStats(game)?'':'⚠️ Names need a fix · not counted in stats\n'}`+`**${gameLabel(game.id)}** · ${safe(game.replay_id || 'Saved replay')}\n${game.voided?'Game voided':resultText(game.payload.match.winner)} · ${stamp(game.recorded_at)}`;
const jobLine = (job,store) => `${stateIcon[job.status]} **${jobLabel(job.id)}**${job.rescore_requested_by?' / Rescore':''} · ${safe(job.replay_id)}\n${job.status==='queued'?`Position **#${store.position(job.id)}**`:job.game_id && store.getGame(job.game_id)?.voided?'Voided':statusName(job.status)}${store.hasPriority(job.user_id)?' · Priority':''} · <@${job.user_id}> · ${stamp(job.submitted_at)}`;

export class DiscordUI {
  constructor(store,recorder,{now=()=>Date.now()}={}) { this.store=store; this.recorder=recorder; this.now=now; this.sessions=new Map(); }
  id(user,action,arg='') { return `rp:${user}:${action}:${arg}`; }
  nav(user) {
    return row([button('Submit replay',this.id(user,'submit'),1),button('Queue',this.id(user,'go','queue')),
      button('My replays',this.id(user,'go','myreplays')),button('Status',this.id(user,'go','status')),button('Help',this.id(user,'go','help'))]);
  }
  session(user,view,args,page) {
    for (const [id,s] of this.sessions) if (s.expires<this.now()) this.sessions.delete(id);
    while (this.sessions.size>=2000) this.sessions.delete(this.sessions.keys().next().value);
    const id=randomBytes(8).toString('hex');
    this.sessions.set(id,{user,view,args,page,expires:this.now()+2*3600_000}); return id;
  }
  getSession(user,id) {
    const s=this.sessions.get(id);
    if (!s || s.expires<this.now()) throw new UserError('This page expired. Use /help to open a new one.');
    if (s.user!==user) throw new UserError('This page belongs to someone else. Use /help to open yours.');
    return s;
  }
  panelToken(user,payload) {
    const controls=(payload?.components || []).flatMap(row=>row.components || []);
    return controls.map(control=>control.custom_id || control.customId || '')
      .find(id=>id.startsWith(this.id(user,'refresh')))?.split(':')[3] || null;
  }
  attachBack(user,payload,previous) {
    const token=this.panelToken(user,payload);
    if (!token) return;
    const current=this.getSession(user,token);
    current.textOnly=['stats','replay','gamematchups','leaderboard'].includes(current.view) && !payload.cardView;
    if (!previous || previous===token) return;
    try { this.getSession(user,previous); } catch { return; }
    current.previous=previous;
    const controls=payload.components.find(row=>row.components.some(control=>control.custom_id===this.id(user,'refresh',token)));
    if (controls?.components.length<5) controls.components.unshift(button('Back',this.id(user,'back',previous),4));
  }
  result(user,view,args,page,e,items=null,format=null) {
    let pages=1;
    const pageSize=view==='leaderboard'?10:PAGE_SIZE;
    const components=[this.nav(user)];
    if (items) {
      pages=Math.max(1,Math.ceil(items.length/pageSize)); page=Math.max(0,Math.min(Number(page)||0,pages-1));
      const slice=items.slice(page*pageSize,(page+1)*pageSize);
      const lines=slice.map((item,i)=>format(item,page*pageSize+i));
      e.description=[e.description,lines.length?lines.join('\n\n'):'Nothing here yet. Submit a replay or try another player.'].filter(Boolean).join('\n\n').slice(0,4096);
      if (view!=='leaderboard') e.footer.text+=` • Page ${page+1}/${pages} • ${items.length} total`;
      if (view==='choosename' && slice.length) components.push(row([{type:3,custom_id:this.id(user,'nameform',args.replay),placeholder:'Choose the original replay name',options:slice.map(entry=>({label:`${entry.original} → ${entry.main}`.slice(0,100),value:entry.original}))}]));
      if (view==='requests' && slice.length) components.push(row([{type:3,custom_id:this.id(user,'openrequest'),placeholder:'Review a name change request',options:slice.map(request=>({label:`#${request.id} · ${request.original} → ${request.main}`,value:String(request.id)}))}]));
      if (['queue','myreplays','recentgames','replays','matchup'].includes(view) && slice.length) {
        components.push(row([{type:3,custom_id:this.id(user,'open'),placeholder:'Open a replay…',options:slice.map(item=>{
          const g=item.game || (item.payload?item:null), value=g?gameLabel(g.id):jobLabel(item.id);
          return {label:`${value} · ${(g||item).replay_id || 'Saved replay'}`.slice(0,100),value};
        })}]));
      }
    }
    const token=this.session(user,view,args,page);
    components.push(row(items && view!=='leaderboard' ? [button('Previous',this.id(user,'prev',token),2,page===0),
      button('Refresh',this.id(user,'refresh',token)),button('Next',this.id(user,'next',token),2,page>=pages-1)]
      : [button('Refresh',this.id(user,'refresh',token))]));
    if (view==='leaderboard') components.push(row([{type:3,custom_id:this.id(user,'ranking',token),placeholder:'Choose a top 10 list',
      options:['kd','wl','submissions'].map(metric=>({label:metricName(metric),value:metric,default:metric===(args.metric || 'kd')}))}]));
    if (view==='help') components.push(row([{type:3,custom_id:this.id(user,'browse'),placeholder:'What would you like to see?',options:[
      {label:'Recent games',value:'recentgames'},{label:'Leaderboards',value:'leaderboard'},{label:'My daily limit',value:'limit'},
      ...(this.store.isAdmin(user)?[{label:'Owner menu',value:'admin'}]:[]),
    ]}]));
    if (view==='stats') components.push(row([
      button('All games',this.id(user,'playergames',args.user)),button('Rivals',this.id(user,'rivals',args.user)),button('Teammates',this.id(user,'teammates',args.user)),
    ]));
    if (view==='matchup') components.push(row([
      button('Switch players',this.id(user,'swap',`${args.user1},${args.user2}`)),
      button('Compare stats',this.id(user,'compare',`${args.user1},${args.user2}`)),
    ]));
    if (['rivals','teammates'].includes(view) && items.length) components.push(row([{type:3,
      custom_id:this.id(user,view==='rivals'?'rival':'player',args.user),placeholder:view==='rivals'?'Open a matchup…':'Pick a teammate…',
      options:items.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE).map(p=>({label:p.b || p.name,value:p.b || p.name})),
    }]));
    const payload={embeds:[e],components,allowedMentions:{parse:[]}};
    // local metadata stays off discord
    if (['stats','replay','gamematchups'].includes(view)) Object.defineProperty(payload,'cardView',{value:
      view==='stats'?{kind:'player',user,name:args.user}:view==='gamematchups'?{kind:'matchups',user,ref:args.replay,name:args.user}:{kind:'game',user,ref:args.replay}});
    if (view==='leaderboard') Object.defineProperty(payload,'cardView',{value:{kind:'leaderboard',user,token,
      metric:args.metric,minimum:args.minimum_games || 1,rows:items.map(p=>({name:p.name,user_id:p.user_id,games:p.games,value:p[args.metric]}))}});
    return payload;
  }
  render(user,view,args={},page=0) {
    if (view!=='help') this.store.requireAccess(user);
    if (ADMIN_COMMANDS.has(view)) this.store.requireAdmin(user);
    const store=this.store;
    args={...args};
    if (['stats','replays','rivals','teammates'].includes(view) && args.user) args.user=store.lookupPlayer(args.user);
    if (['matchup','compare'].includes(view)) { args.user1=store.lookupPlayer(args.user1); args.user2=store.lookupPlayer(args.user2); }
    let e,items=null,format=null;
    switch(view) {
      case 'help': {
        e=embed('Scority','Add a replay, check your place in the queue, and see everyone’s stats.\nUse Minecraft names to look up players. Only you can see your command replies.');
        e.fields.push(field('Your replays','`/submit` · `/queue` · `/status` · `/limit` · `/myreplays` · `/cancel`'),
          field('Find games','`/recentgames` · `/replays user:<name>` · `/replay` · `/export` · `/names` · `/myrequests`'),
          field('Player stats','`/stats` · `/matchup` · `/compare` · `/rivals` · `/teammates` · `/leaderboard`'),
          field('Daily limit',`Everyone can add up to ${this.store.runtimeSetting('submissions.dailyLimit',DAILY_LIMIT)} replays a day. Your limit resets at midnight Pacific. Adding the same replay twice does not count again. Cancelling a replay still uses a spot.`));
        e.fields.push(field('Names and shared alts',`${NICK_REMINDER} If someone used a shared alt, open the game and press **Request name change**. I’ll review it before any stats change.`));
        e.fields.push(field('Replay length','Replays must be at least 3 minutes long (180 seconds). Shorter replays are skipped and still use a daily spot.'));
        e.fields.push(field('When it’s ready', 'We’ll DM you when your replay is scored. If DMs are off, check **My replays**.'));
        if (store.isAdmin(user)) e.fields.push(field('Owner commands','`/admin` · `/priority` · `/nolimit` · `/resetlimit` · `/retry` · `/rescore` · `/pause` · `/resume` · `/setwinner` · `/audit` · `/nickadd` · `/nickremove` · `/alt` · `/altremove` · `/setname` · `/resetname` · `/requests` · `/void` · `/unvoid`'));
        break;
      }
      case 'submitted': {
        const job=store.getJob(args.id), q=store.quota(user);
        e=embed('You’re in the queue',`**${jobLabel(job.id)}**${job.rescore_requested_by?' / Rescore':''} · ${safe(job.replay_id)}\nQueue position: **#${store.position(job.id)}**\n${q.unlimited?'**Unlimited submissions** enabled.':`**${q.remaining}/${q.limit}** replays left today. Resets <t:${q.reset}:R>.`}`);
        e.fields.push(field('Replay length','Only replays at least 3 minutes long can be scored.'));
        e.fields.push(field('What happens next','We’ll DM you when your replay is scored. You can also check **My replays**.'));
        if (this.recorder.status().connection!=='online') e.fields.push(field('Scoring is offline','Your replay is saved. It will start when I’m back online.'));
        return this.result(user,'replay',{replay:jobLabel(job.id)},0,e);
      }
      case 'queue':
        e=embed(store.paused()?'Queue paused':'Replay queue','#1 is next or being scored now. Priority users go first, then submission order. A recording already in progress finishes first.');
        items=store.queue(); format=j=>jobLine(j,store); break;
      case 'myreplays':
        e=embed('My replays','All the replays you added, with their latest updates.');
        items=store.jobs(user); format=j=>jobLine(j,store); break;
      case 'recentgames':
        e=embed('Recent games'); items=store.games(); format=gameLine; break;
      case 'replays':
        args.user=ign(args.user); e=embed(`Games with ${args.user}`,'Games this player was in, no matter who added them.');
        items=playerGames(store.games(),args.user); format=gameLine; break;
      case 'status': {
        const s=this.recorder.status(), q=store.quota(user), mine=store.queue().filter(j=>j.user_id===user);
        e=embed('Bot status',s.broken?'Scoring has stopped. I need to reconnect.':s.connection==='online'?'Ready to score replays.':s.connection==='connecting'?'Getting ready to score replays…':'Scoring is offline. Your replays will wait in the queue.');
        e.fields.push(field('Queue',`${s.queueSize} in the queue · ${s.paused?'paused':'running'}`,true),
          field('Your daily limit',q.unlimited?'Unlimited submissions':`${q.remaining}/${q.limit} left · resets <t:${q.reset}:R>`,true),
          field('Your queue positions',mine.map(j=>`${jobLabel(j.id)} → #${store.position(j.id)}`).join('\n') || 'You have no replays waiting'));
        if(s.workers){
          for(const worker of s.workers)e.fields.push(field(safe(worker.label),
            `${worker.connection}${worker.active?` · ${jobLabel(worker.active.id)} · ${safe(worker.active.replay_id)}`:' · no replay recording'}${worker.hud?`\n${worker.hud.state} · ${worker.hud.elapsedSec}/${worker.hud.totalSec}s · ${worker.hud.speed}×`:''}`));
        }else{
          if (s.active) e.fields.push(field('Scoring now',`${jobLabel(s.active.id)} · ${safe(s.active.replay_id)}`));
          if (s.hud) e.fields.push(field('Replay progress',`${s.hud.state} · ${s.hud.elapsedSec}/${s.hud.totalSec}s · ${s.hud.speed}×`));
        }
        if (s.lastError) e.fields.push(field('Last issue',issueText(s.lastError)));
        break;
      }
      case 'limit': {
        const q=store.quota(user); e=embed('Your daily limit',q.unlimited?`**Unlimited submissions** until revoked by the owner.\nUsed today: ${q.used}.`:`**${q.remaining} of ${q.limit}** replays left today.\nUsed today: ${q.used}.\nResets <t:${q.reset}:F> · <t:${q.reset}:R>.`);
        e.fields.push(field('When it resets','Your limit resets at midnight Pacific. The owner can grant a lasting exemption with /nolimit.')); break;
      }
      case 'replay': {
        const job=store.findJob(args.replay), game=store.findGame(args.replay);
        if (!job && !game) throw new UserError('Replay not found. Choose one from /myreplays or /recentgames.');
        if (game) {
          const p=game.payload;
          const rescore=store.rescoreJob(game.id);
          const duration=Number.isFinite(p.match.totalDurationSec)?`${Math.floor(p.match.totalDurationSec/60)}m ${Math.floor(p.match.totalDurationSec%60)}s`:'Length not recorded';
          e=embed(`Game results · ${gameLabel(game.id)}`,`**${game.voided?'Game voided':resultText(p.match.winner)}**\n${duration} · ${stamp(game.recorded_at)}`);
          e.footer.text=`${game.winner_reviewed?'Result checked by me':'Result scored by the bot'} · ${NICK_REMINDER}`;
          const sides=gameTeams(p),teams=[...sides.toSorted((a,b)=>(b===p.match.winner)-(a===p.match.winner)),null];
          for (const team of teams) {
            const players=Object.entries(p.players).filter(([,v])=>(v.team || null)===team).sort((a,b)=>b[1].kills-a[1].kills || a[0].localeCompare(b[0]));
            const outcome=!game.voided && team && teamKnown(p.match.winner)?` · ${team===p.match.winner?'WIN':'LOSS'}`:'';
            if (players.length) e.fields.push(field(team===null?'Team not recorded':`${teamLabel(team)}${outcome}`,players.map(([name,v])=>`**${safe(name)}**\n${v.kills} kills · ${v.deaths} deaths · ${v.finalKills} finals · ${v.bedBreaks} beds\n${extendedLine(visibleStats(v,game.payload.tracking))}`).join('\n\n'),true));
          }
          if (p.awards?.firstBlood) e.fields.push(field('First blood',safe(p.awards.firstBlood)));
          e.fields.push(field('Team upgrades · est. acquired by',
            sides.map(team=>`${teamLabel(team)}: ${upgradeLine(p.teamUpgrades,team)}`).join('\n')));
          e.fields.push(field('Replay ID',safe(game.replay_id || 'Saved replay')));
          if(rescore){
            const message=rescore.status==='queued'?`Queued at **#${store.position(rescore.id)}**. Showing the previous results until it finishes.`:
              rescore.status==='recording'?'Recording again. Showing the previous results until it finishes.':
              rescore.status==='completed'?`Results refreshed ${stamp(rescore.finished_at)}.`:
              `Rescore ${statusName(rescore.status).toLowerCase()}. Previous results kept.${rescore.error?`\n${safe(rescore.error)}`:''}`;
            e.fields.push(field('Rescore',`${jobLabel(rescore.id)} · ${message}`));
          }
          if (game.voided) e.fields.push(field('Game voided',`This game does not count toward stats or leaderboards.\n${safe(game.void_reason)}`));
          if (p.nameLinks?.excludedFromStats) e.fields.push(field('Names need a fix',`This game is left out of all stats because a name link would combine different players. I need to fix these names before this game can count.\n${p.nameLinks.conflicts.map(c=>`${c.names.join(' + ')} → ${c.main}`).join('\n')}`));
          const changed=p.nameLinks.assignments.filter(entry=>entry.scope!=='original');
          if (changed.length) e.fields.push(field('Name links',changed.map(entry=>`${safe(entry.original)} → **${safe(entry.main)}** · ${entry.scope==='game'?'this game only':'all games'}`).join('\n')));
          if (p.warnings?.length) e.fields.push(field('Please check','Some game details may be wrong. Ask me to check the teams and winner.'));
          if (job?.user_id===user && store.completionDM(job.id)?.status==='failed') e.fields.push(field('DM update', 'We could not send you a DM. Your results are right here.'));
          if (game.review_reason) e.fields.push(field('My note',safe(game.review_reason)));
          const result=this.result(user,view,args,page,e);
          result.components.push(row([button('Game matchups',this.id(user,'gamematchups',gameLabel(game.id)),2,game.voided),button('Download results',this.id(user,'export',gameLabel(game.id)),1),button(store.isAdmin(user)?'Change a name':'Request name change',this.id(user,'requestname',gameLabel(game.id)))]));
          if (store.isAdmin(user)) result.components.at(-1).components.push(button(game.voided?'Restore game':'Void game',this.id(user,game.voided?'unvoid':'void',gameLabel(game.id)),game.voided?2:4));
          if(store.isAdmin(user))result.components.at(-1).components.push(rescore?.status==='queued'
            ?button('Cancel rescore',this.id(user,'cancel',jobLabel(rescore.id)),4)
            :button(rescore?.status==='recording'?'Rescoring…':'Rescore game',this.id(user,'rescore',gameLabel(game.id)),2,!game.replay_id||rescore?.status==='recording'));
          const names=Object.keys(p.players).filter(name=>/^[A-Za-z0-9_]{1,16}$/.test(name)).slice(0,25);
          if (names.length) result.components.push(row([{type:3,custom_id:this.id(user,'player'),placeholder:'Pick a player to see their stats…',options:names.map(name=>({label:name,value:name}))}]));
          return result;
        }
        e=embed(`${jobLabel(job.id)} · ${job.replay_id}`,jobLine(job,store));
        if (job.error) e.fields.push(field('Details',issueText(job.error)));
        if (job.status==='invalid' && job.user_id===user && store.completionDM(job.id)?.status==='failed') e.fields.push(field('DM update','I couldn’t DM you. You can check this replay here in My replays.'));
        e.fields.push(field('Attempts',job.attempts,true),field('Submitted',stamp(job.submitted_at),true));
        const result=this.result(user,view,args,page,e);
        if (job.status==='queued' && (job.user_id===user || store.isAdmin(user))) result.components.push(row([button('Cancel replay',this.id(user,'cancel',jobLabel(job.id)),4)]));
        if (store.isAdmin(user) && ['failed','cancelled'].includes(job.status)) result.components.push(row([button('Try again',this.id(user,'retry',jobLabel(job.id)),1)]));
        return result;
      }
      case 'gamematchups': {
        const game=store.findGame(args.replay); if (!game) throw new UserError('Choose a finished replay.');
        args.replay=gameLabel(game.id);
        const players=Object.entries(game.payload.players).filter(([name])=>/^[A-Za-z0-9_]{1,16}$/.test(name)).map(([name,p])=>({name,team:p.team,
          source:countsForStats(game)?game.payload.nameLinks?.assignments.find(entry=>entry.main.toLowerCase()===name.toLowerCase())?.original || name:name}));
        args.user=args.user || players.find(p=>teamKnown(p.team))?.source || players[0]?.source;
        let stats;
        try { stats=gameMatchups(game,args.user); }
        catch (error) { if (!(error instanceof UserError)) throw error; e=embed(`${args.replay} · Game matchups`,error.message); }
        if (stats) {
          e=embed(`${stats.name} · Game matchups`,`${args.replay} · Kills, deaths, assists and PvP damage for **${safe(stats.name)}** against each opponent in this game.\nDamage is in HP (2 HP = 1 heart).`);
          e.fields.push(field('Assists',statNumber(stats.assists)),field('PvP damage',damageLine(stats)));
          e.fields.push(field('Diamonds voided this game',statNumber(stats.diamondsVoided)));
          e.fields.push(field('Item usage this game',itemUsageLine(stats)));
          if (!stats.opponents.length) e.fields.push(field('No opponents recorded','Try another player or ask me to check this game.'));
          for (const p of stats.opponents.slice(0,20)) e.fields.push(field(`vs ${p.name}`,`${p.kills} kills · ${p.deaths} deaths · ${statNumber(p.assists)} assists · **${displayRatio(p.kd)} K/D**\n${damageLine(p)}`));
          if (stats.opponents.length>20) e.fields.push(field('More opponents','Download the replay results to see the full game.'));
          if (stats.unassignedCount) e.fields.push(field('Please check','Players whose teams were not recorded are left out of these matchups.'));
        }
        page=Math.max(0,Math.min(page,Math.ceil(players.length/25)-1));
        const result=this.result(user,view,args,page,e);
        const controls=result.components[1].components;
        controls.push(button('Game results',this.id(user,'detail',args.replay)));
        if (players.length>25) controls.push(button('Previous players',this.id(user,'prev',this.panelToken(user,result)),2,page===0),
          button('More players',this.id(user,'next',this.panelToken(user,result)),2,(page+1)*25>=players.length));
        const visible=players.slice(page*25,(page+1)*25);
        if (visible.length) result.components.push(row([{type:3,custom_id:this.id(user,'gameplayer',args.replay),placeholder:'Choose a player for this game',
          options:visible.map(p=>({label:`${p.name} · ${teamLabel(p.team)}`,
            value:p.source,default:p.source.toLowerCase()===String(args.user).toLowerCase()}))}]));
        return result;
      }
      case 'stats': {
        const p=playerStats(store.games(),args.user); e=embed(`${p.name} · Player stats`,`**${winLossText(p.wins,p.losses)}**\n${p.games} ${p.games===1?'game':'games'} played`);
        e.fields.push(field('Kills & deaths',`${p.kills} kills · ${p.deaths} deaths`,true),
          field('Finals & beds',`${p.finalKills} final kills\n${p.bedBreaks} bed breaks`,true),
          field('Wins & streaks',`${displayRatio(p.wl)} W/L · ${p.winrate}% win rate\nBest kill streak: ${p.longestStreak}`,true),
          field('Recent results',p.history.filter(h=>h.outcome==='win' || h.outcome==='loss').slice(0,10).map(h=>h.outcome==='win'?'🟩':'🟥').join(' ') || 'No results yet'));
        e.fields.push(field('Assists',`${statNumber(p.assists)} · ${p.newStatsGames.assists} of ${p.games} games recorded`,true));
        e.fields.push(field('Diamonds',statNumber(p.diamondsCollected),true),field('Emeralds',statNumber(p.emeraldsCollected),true));
        e.fields.push(field('Diamonds voided',`${statNumber(p.diamondsVoided)} · ${p.newStatsGames.diamondsVoided} of ${p.games} games recorded`,true));
        e.fields.push(field('Item usage',`${itemUsageLine(p)}\n${p.newStatsGames.goldenApplesEaten} of ${p.games} games recorded`));
        e.fields.push(field('Damage dealt',`${damageNumber(p.damageDealt)} HP`,true),field('Damage received',`${damageNumber(p.damageReceived)} HP`,true),
          field('Damage games',`${p.newStatsGames.damageDealt} of ${p.games} games recorded`));
        break;
      }
      case 'matchup': {
        const p=matchup(store.games(),args.user1,args.user2);
        e=embed(`${p.a} vs ${p.b}`,`**${winLossText(p.wins,p.losses)}** for ${safe(p.a)}\n${p.games} games against ${safe(p.b)}`);
        e.fields.push(field('Kills against each other',`${safe(p.a)} killed ${safe(p.b)} **${p.kills}** times.\n${safe(p.a)} died to ${safe(p.b)} **${p.deaths}** times.\nK/D against each other: **${displayRatio(p.kd)}**`));
        if (p.teammateGames) e.fields.push(field('As teammates',`${p.teammateGames} games together`));
        items=p.history; format=h=>`${gameLine(h.game)}\n${h.outcome==='win'?'🟩 Win · ':h.outcome==='loss'?'🟥 Loss · ':''}${h.kills} kills / ${h.deaths} deaths`; break;
      }
      case 'compare': {
        const a=playerStats(store.games(),args.user1), b=playerStats(store.games(),args.user2);
        if (a.name.toLowerCase()===b.name.toLowerCase()) throw new UserError('Choose two different Minecraft players.');
        e=embed(`${a.name} & ${b.name} · Stats comparison`,'Stats from all their games, not just games against each other.');
        for (const p of [a,b]) e.fields.push(field(p.name,`**${winLossText(p.wins,p.losses)}** · ${p.games} games\n${p.kills} kills · ${p.deaths} deaths · ${displayRatio(p.kd)} K/D\n${p.finalKills} finals · ${p.bedBreaks} beds\n${p.winrate}% win rate\n${extendedLine(p)}`,true));
        break;
      }
      case 'leaderboard': {
        args.metric ||= 'kd';
        const submissions=args.metric==='submissions';
        e=embed(`Top 10 · ${metricName(args.metric)}`,submissions?'Discord users ranked by unique replays submitted. Invalid and voided replays do not count.':`Minecraft players with at least ${args.minimum_games || 1} game(s).`);
        items=submissions?store.submissionLeaderboard():leaderboard(store.games(),args.metric,args.minimum_games || 1);
        format=(p,i)=>`${['🥇','🥈','🥉'][i] || `**${i+1}.**`} ${submissions?`<@${p.user_id}>`:`**${safe(p.name)}**`} · **${submissions?p.submissions:displayRatio(p[args.metric])}** ${submissions?'replays':metricName(args.metric)}`;
        break;
      }
      case 'teammates':
        e=embed(`${ign(args.user)} · Teammates`,'How often they win when they play on the same team.');
        items=teammates(store.games(),args.user); format=p=>`**${safe(p.name)}** · ${p.games} shared games\n${winLossText(p.wins,p.losses)}`; break;
      case 'rivals':
        e=embed(`${ign(args.user)} · Rivals`,'The players they face the most, and how they did against them.');
        items=rivals(store.games(),args.user); format=p=>`**${safe(p.b)}** · ${p.games} games against each other\n${winLossText(p.wins,p.losses)} · ${p.kills} kills / ${p.deaths} deaths`; break;
      case 'choosename': {
        const game=store.findGame(args.replay); if (!game) throw new UserError('Choose a finished replay.');
        e=embed(store.isAdmin(user)?'Change a name':'Request a name change',`${gameLabel(game.id)} · Choose the name recorded in the replay.\nThis change is for this game only.${store.isAdmin(user)?'':' I’ll review it first.'}`);
        items=game.payload.nameLinks.assignments; format=entry=>`**${safe(entry.original)}** → ${safe(entry.main)}`;
        break;
      }
      case 'names': {
        if (args.user) args.user=store.resolvePlayer(args.user);
        e=embed(args.user?`Names linked to ${args.user}`:'Nick and alt links','These links apply to past and future games. Changes made for one game take priority. Shared alts should use the name change button on the game.');
        items=store.nameLinks().filter(link=>!args.user || link.main.toLowerCase()===args.user.toLowerCase());
        format=link=>`**${safe(link.alias)}** → **${safe(link.main)}** · ${link.kind}`;
        break;
      }
      case 'requests':
      case 'myrequests': {
        e=embed(view==='requests'?'Name requests waiting':'Your name change requests','Name changes only count after I approve them.');
        items=store.nameRequests(view==='myrequests'?user:null).filter(r=>view==='myrequests' || r.status==='pending');
        format=r=>`**#${r.id}** · ${gameLabel(r.game_id)} · ${r.status}\n${safe(r.original)} → **${safe(r.main)}**\n${safe(r.reason)}${r.dm_status==='failed'?'\nI couldn’t get a DM about this, but your request is still saved.':''}`;
        break;
      }
      case 'request': {
        const request=store.nameRequest(Number(args.id));
        if (!request) throw new UserError('That request could not be found. Use /requests.');
        e=embed(`Name change #${request.id}`,`${gameLabel(request.game_id)} · **${request.status}**\n${safe(request.original)} → **${safe(request.main)}**\nRequested by <@${request.user_id}>\nThis changes only this game, including its stats.`);
        e.fields.push(field('Reason',safe(request.reason)));
        const result=this.result(user,view,args,page,e);
        result.components.push(row([button('Approve',this.id(user,'approvename',request.id),2,request.status!=='pending'),button('Reject',this.id(user,'rejectname',request.id),4,request.status!=='pending'),button('View game',this.id(user,'detail',gameLabel(request.game_id)))]));
        return result;
      }
      case 'priority':
        e=embed('Priority users','Use /priority user:<person> to grant priority, or enabled:false to remove it. Daily submissions are limited to five unless the owner grants /nolimit.'); items=store.priorityMembers(); format=p=>`<@${p.user_id}> · \`${p.user_id}\` · added ${stamp(p.added_at)}`; break;
      case 'audit':
        e=embed('Recent changes','Latest 100 changes.'); items=store.audit(); format=p=>`**${auditName(p.action)}** by <@${p.actor}> · ${stamp(p.created_at)}\n${auditDetail(p.detail)}`; break;
      case 'admin': {
        const jobs=store.jobs(), failed=jobs.filter(j=>j.status==='failed');
        e=embed('Owner menu',`${store.paused()?'⏸ Queue paused':'▶ Queue running'} · ${store.queue().length} in the queue · ${store.games().length} games\nPublic access · ${store.priorityMembers().length} priority users · ${failed.length} replays that could not finish`);
        e.fields.push(field('Names to check',`${store.nameRequests().filter(r=>r.status==='pending').length} requests waiting · ${store.games().filter(g=>g.payload.nameLinks?.excludedFromStats).length} games left out of stats because of name links`));
        e.fields.push(field('Games with name conflicts',store.games().filter(g=>g.payload.nameLinks?.excludedFromStats).slice(0,5).map(g=>gameLabel(g.id)).join(', ') || 'None'));
        e.fields.push(field('Replays that need help',failed.slice(0,5).map(j=>`${jobLabel(j.id)} · ${safe(j.replay_id)} · ${issueText(j.error)}`).join('\n') || 'None'));
        const result=this.result(user,view,args,page,e);
        result.components.push(row([button(store.paused()?'Resume queue':'Pause queue',this.id(user,store.paused()?'resume':'pause'),1),button('Priority users',this.id(user,'go','priority')),button('Recent changes',this.id(user,'go','audit')),button('Name requests',this.id(user,'go','requests')),button('Name links',this.id(user,'go','names'))]));return result;
      }
      case 'confirmcancel': {
        const job=store.findJob(args.replay);
        if (!job || (job.user_id!==user && !store.isAdmin(user))) throw new UserError('You can only cancel your own waiting replays.');
        if (job.status!=='queued') throw new UserError('That replay is no longer waiting in the queue.');
        e=embed(job.rescore_requested_by?'Cancel this rescore?':'Cancel this replay?',`${jobLabel(job.id)} · ${safe(job.replay_id)}\n${job.rescore_requested_by?'This removes the rescore from the queue. The saved results stay available; no daily spot was charged.':`This removes it from the queue. It will still count toward your ${this.store.runtimeSetting('submissions.dailyLimit',DAILY_LIMIT)} replays today.`}`);
        return {embeds:[e],components:[row([button('Yes, cancel',this.id(user,'confirmcancel',jobLabel(job.id)),4),button('Keep in queue',this.id(user,'detail',jobLabel(job.id)))])],allowedMentions:{parse:[]}};
      }
      default: throw new UserError('This page is not available. Use /help to start again.');
    }
    if (['stats','matchup','compare','leaderboard','rivals','teammates'].includes(view) && !(view==='leaderboard' && args.metric==='submissions')) {
      const excluded=store.games().filter(game=>game.payload.nameLinks?.excludedFromStats).length;
      if (excluded) e.fields.push(field('Names to check',`${excluded} game(s) are left out of stats until I fix conflicting name links.`));
    }
    return this.result(user,view,args,page,e,items,format);
  }
  notice(user,title,message) { return {embeds:[embed(title,message)],components:[this.nav(user)],allowedMentions:{parse:[]}}; }
}
