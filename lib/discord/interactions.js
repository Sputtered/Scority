import { AttachmentBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';
import { ADMIN_COMMANDS } from './commands.js';
import { UserError, gameLabel, jobLabel, DAILY_LIMIT } from './store.js';
import { statusName } from './theme.js';
import { playerNames } from './stats.js';

export function createInteractionHandler({store,ui,cards=null,log=console.error}) {
  async function present(interaction,payload,previous=undefined) {
    ui.attachBack(interaction.user.id,payload,previous===undefined?ui.panelToken(interaction.user.id,interaction.message):previous);
    const result=cards?await cards.decorate(payload):payload;
    return interaction.editReply({...result,attachments:[]});
  }
  const modal = user => new ModalBuilder().setCustomId(ui.id(user,'submitmodal')).setTitle('Submit a replay')
    .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('replay').setLabel('Replay ID (try not to use nicks/alts)')
      .setPlaceholder('Paste a replay ID. Replay must be 3+ minutes.').setStyle(TextInputStyle.Short).setMaxLength(110).setRequired(true)));
  function nameModal(user, ref, input) {
    const game=store.findGame(ref); if (!game) throw new UserError('Choose a finished replay.');
    const original=store.originalName(game,input), admin=store.isAdmin(user);
    const token=ui.session(user,'nameform',{replay:gameLabel(game.id),original,state:store.nameState(game)},0);
    const form=new ModalBuilder().setCustomId(ui.id(user,admin?'editnamemodal':'requestnamemodal',token))
      .setTitle(`${admin?'Change':'Request'} name · Avoid nicks/alts`)
      .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('main').setLabel(`Main name for ${original}`)
        .setPlaceholder('Use the player’s main Minecraft name').setStyle(TextInputStyle.Short).setMaxLength(16).setRequired(true)));
    if (!admin) form.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Why should this name change?')
      .setPlaceholder('Who used this alt in this game?').setStyle(TextInputStyle.Paragraph).setMaxLength(200).setRequired(true)));
    return form;
  }
  function execute(user,command,args) {
    if (command!=='help') store.requireAccess(user);
    if (ADMIN_COMMANDS.has(command)) store.requireAdmin(user);
    switch(command) {
      case 'submit': { const job=store.submit(user,args.replay); return ui.render(user,'submitted',{id:job.id}); }
      case 'priority': {
        if(!args.user){if(args.enabled!==undefined)throw new UserError('Choose a user to change priority.');return ui.render(user,'priority');}
        const enabled=args.enabled??true,id=store.setPriority(user,args.user,enabled);
        return ui.notice(user,enabled?'Priority granted':'Priority removed',`<@${id}> now has ${enabled?'priority':'standard'} queue placement. ${store.hasNoLimit(id)?'Unlimited submissions remain enabled.':`The daily limit is still ${store.runtimeSetting('submissions.dailyLimit',DAILY_LIMIT)}.`}`);
      }
      case 'nolimit': {
        const enabled=args.enabled??true,id=store.setNoLimit(user,args.user,enabled);
        return ui.notice(user,enabled?'Daily limit removed':'Daily limit restored',enabled?
          `<@${id}> has unlimited daily submissions until revoked with /nolimit user:<person> enabled:false.`:
          `<@${id}> has ${store.quota(id).remaining}/${store.runtimeSetting('submissions.dailyLimit',DAILY_LIMIT)} replay spots left today. Today's usage is preserved.`);
      }
      case 'resetlimit': { const id=store.resetLimit(user,args.id); return ui.notice(user,'Daily limit reset',store.hasNoLimit(id)?`<@${id}>'s usage was reset. Unlimited submissions remain enabled.`:`<@${id}> now has ${store.runtimeSetting('submissions.dailyLimit',DAILY_LIMIT)} replay spots available today.`); }
      case 'pause': store.pause(user,true); return ui.render(user,'admin');
      case 'resume': store.pause(user,false); return ui.render(user,'admin');
      case 'retry': { const job=store.retry(user,args.replay); return ui.render(user,'replay',{replay:jobLabel(job.id)}); }
      case 'rescore': { const job=store.rescore(user,args.replay); return ui.render(user,'replay',{replay:gameLabel(job.game_id)}); }
      case 'cancel': return ui.render(user,'confirmcancel',args);
      case 'confirmcancel': { const job=store.cancel(user,args.replay); return ui.notice(user,job.rescore_requested_by?'Rescore cancelled':'Replay cancelled',`${jobLabel(job.id)} was removed from the queue. ${job.rescore_requested_by?'Previous results are still saved; no daily spot was charged.':'It still counts toward your daily limit.'}`); }
      case 'setwinner': { const game=store.setWinner(user,args.replay,args.team,args.reason); return ui.render(user,'replay',{replay:gameLabel(game.id)}); }
      case 'void':
      case 'unvoid': {
        const game=store.setVoided(user,args.replay,command==='void',args.reason);
        return ui.render(user,'replay',{replay:gameLabel(game.id)});
      }
      case 'nickadd':
      case 'alt': {
        const link=store.addNameLink(user,args.nick || args.alt,args.main,command==='nickadd'?'nick':'alt');
        return ui.notice(user,'Name linked',`**${link.alias}** now counts as **${link.main}** in ${link.count} saved game(s) and future games. Changes made for one game stay in place.\nStats and matchup results use the new name right away.`);
      }
      case 'nickremove':
      case 'altremove': {
        const link=store.removeNameLink(user,args.name,command==='nickremove'?'nick':'alt',args.revert ?? true);
        return ui.notice(user,'Name link removed',`**${link.alias}** will use its original name in future games.\n${link.revert?'Past uses of this link now use the original name.':'Past names were kept as changes for those games.'} Changes made for one game stay in place.`);
      }
      case 'setname':
      case 'resetname': {
        const game=command==='setname'?store.setGameName(user,args.replay,args.user,args.main):store.resetGameName(user,args.replay,args.user,args.mode);
        return ui.render(user,'replay',{replay:gameLabel(game.id)});
      }
      case 'approvename':
      case 'rejectname': {
        const request=store.reviewNameRequest(user,Number(args.id),command==='approvename');
        return ui.render(user,'request',{id:request.id});
      }
      case 'export': {
        const game=store.findGame(args.replay); if (!game) throw new UserError('Choose a finished replay to download.');
        const buffer=Buffer.from(JSON.stringify(game.payload,null,2));
        if (buffer.length>7*1024*1024) throw new UserError('This file is too large to send here. Ask me for a copy.');
        return {...ui.notice(user,'Replay results',`${gameLabel(game.id)} · Your results file is attached.`),files:[new AttachmentBuilder(buffer,{name:`${gameLabel(game.id)}.json`})]};
      }
      default: return ui.render(user,command,args);
    }
  }
  return async function handle(interaction) {
    const user=interaction.user.id;
    try {
      if (interaction.isAutocomplete()) {
        if (!store.allowed(user) || (ADMIN_COMMANDS.has(interaction.commandName) && !store.isAdmin(user))) return await interaction.respond([]);
        const focused=interaction.options.getFocused(true), query=String(focused.value).toLowerCase();
        let values=focused.name==='replay'
          ? [...store.jobs().map(j=>({name:`${jobLabel(j.id)} · ${j.replay_id} · ${statusName(j.status)}`,value:jobLabel(j.id)})),
            ...store.games().map(g=>({name:`${gameLabel(g.id)} · ${g.replay_id || 'Saved replay'}`,value:gameLabel(g.id)}))]
          : [...new Map([...playerNames(store.games()).map(name=>({name,value:name})),
            ...store.nameLinks().map(link=>({name:`${link.alias} → ${link.main} (${link.kind})`,value:link.alias}))]
            .map(value=>[value.value.toLowerCase(),value])).values()];
        if (focused.name==='user' && ['setname','resetname'].includes(interaction.commandName)) {
          const ref=interaction.options.data?.find(option=>option.name==='replay')?.value;
          const game=ref && store.findGame(ref);
          values=game?game.payload.nameLinks.assignments.map(entry=>({name:`${entry.original} → ${entry.main}`,value:entry.original})):[];
        }
        return await interaction.respond(values.filter(v=>v.name.toLowerCase().includes(query)).slice(0,25).map(v=>({...v,name:v.name.slice(0,100)})));
      }
      if (interaction.isChatInputCommand()) {
        const command=interaction.commandName;
        if (command!=='help') store.requireAccess(user);
        if (ADMIN_COMMANDS.has(command)) store.requireAdmin(user);
        const args=Object.fromEntries((interaction.options.data || []).map(o=>[o.name,o.value]));
        if (command==='submit' && !args.replay) return await interaction.showModal(modal(user));
        await interaction.deferReply({flags:MessageFlags.Ephemeral});
        return await present(interaction,execute(user,command,args));
      }
      if (!(interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit())) return;
      const [prefix,owner,action,arg]=String(interaction.customId).split(':');
      if (prefix!=='rp') return;
      if (owner==='public') {
        const player=/^rp:public:gameplayer:(G\d+),([A-Za-z0-9_]{1,16})$/.exec(interaction.customId);
        const more=/^rp:public:gameplayers:(G\d+)$/.exec(interaction.customId);
        if (!interaction.isButton() || (!player && !more)) throw new UserError('This button is not working. Open /help and try again.');
        store.requireAccess(user);
        await interaction.deferReply({flags:MessageFlags.Ephemeral});
        return await present(interaction,ui.render(user,'gamematchups',{replay:(player || more)[1],user:player?.[2]}),null);
      }
      if (owner!==user) throw new UserError('This page belongs to someone else. Use /help to open yours.');
      if (!(action==='go' && arg==='help')) store.requireAccess(user);
      if (action==='submit') return await interaction.showModal(modal(user));
      if (action==='nameform' && interaction.isStringSelectMenu()) return await interaction.showModal(nameModal(user,arg,interaction.values[0]));
      if (interaction.isModalSubmit()) {
        if (['editnamemodal','requestnamemodal'].includes(action)) {
          if (action==='editnamemodal') store.requireAdmin(user);
          const session=ui.getSession(user,arg);
          if (session.view!=='nameform') throw new UserError('This form expired. Open the game and try again.');
          const {replay,original,state}=session.args;
          const game=store.findGame(replay);
          if (!game || store.nameState(game)!==state) throw new UserError('The names changed while this form was open. Open the game and try again.');
          await interaction.deferReply({flags:MessageFlags.Ephemeral});
          const main=interaction.fields.getTextInputValue('main');
          if (action==='editnamemodal') return await present(interaction,execute(user,'setname',{replay,user:original,main}));
          const request=store.requestNameChange(user,replay,original,main,interaction.fields.getTextInputValue('reason'),state);
          return await present(interaction,ui.notice(user,'Name change requested',`Request **#${request.id}** is saved. I’ll review **${original} → ${request.main}** for **${replay}**.\nStats will change only if approved. Check /myrequests for updates.`));
        }
        if (action!=='submitmodal') throw new UserError('This form expired. Try /submit again.');
        await interaction.deferReply({flags:MessageFlags.Ephemeral});
        return await present(interaction,execute(user,'submit',{replay:interaction.fields.getTextInputValue('replay')}));
      }
      // separate replies prevent stale attachments
      if (action==='export') {
        await interaction.deferReply({flags:MessageFlags.Ephemeral});
        return await present(interaction,execute(user,'export',{replay:arg}));
      }
      await interaction.deferUpdate();
      let payload,previous;
      if (action==='back') {
        const s=ui.getSession(user,arg);
        payload=ui.render(user,s.view,s.args,s.page);
        if (s.textOnly) payload={...payload};
        previous=s.previous || null;
      } else if (['prev','next','refresh'].includes(action)) {
        const s=ui.getSession(user,arg), page=s.page+(action==='next'?1:action==='prev'?-1:0);
        payload=ui.render(user,s.view,s.args,page);
        if (s.textOnly) payload={...payload};
        previous=s.previous || null;
      } else if (action==='go') payload=ui.render(user,arg);
      else if (action==='requestname') payload=ui.render(user,'choosename',{replay:arg});
      else if (action==='gamematchups' || action==='gameplayer') {
        payload=ui.render(user,'gamematchups',{replay:arg,user:action==='gameplayer'?interaction.values[0]:undefined});
        if (!ui.panelToken(user,interaction.message)) previous=ui.session(user,'replay',{replay:arg},0);
      }
      // spreading removes local card metadata
      else if (action==='textstats') payload={...ui.render(user,'stats',{user:arg})};
      else if (action==='textgame') payload={...ui.render(user,'replay',{replay:arg})};
      else if (action==='textranking') {
        const s=ui.getSession(user,arg);
        if (s.view!=='leaderboard') throw new UserError('Open /leaderboard to see the list.');
        payload={...ui.render(user,'leaderboard',s.args)};
      }
      else if (action==='textmatchups') {
        const [replay,name]=arg.split(',');payload={...ui.render(user,'gamematchups',{replay,user:name})};
      }
      else if (action==='openrequest') payload=ui.render(user,'request',{id:interaction.values[0]});
      else if (['approvename','rejectname'].includes(action)) payload=execute(user,action,{id:arg});
      else if (action==='browse') payload=ui.render(user,interaction.values[0]);
      else if (action==='ranking') {
        const s=ui.getSession(user,arg);
        if (s.view!=='leaderboard') throw new UserError('Open /leaderboard to choose a list.');
        payload=ui.render(user,'leaderboard',{...s.args,metric:interaction.values[0]});
      }
      else if (action==='player') payload=ui.render(user,'stats',{user:interaction.values[0]});
      else if (action==='rival') payload=ui.render(user,'matchup',{user1:arg,user2:interaction.values[0]});
      else if (['playergames','rivals','teammates'].includes(action)) payload=ui.render(user,action==='playergames'?'replays':action,{user:arg});
      else if (action==='swap' || action==='compare') {
        const [a,b]=arg.split(',');
        payload=ui.render(user,action==='swap'?'matchup':'compare',{user1:action==='swap'?b:a,user2:action==='swap'?a:b});
      }
      else if (action==='detail' || action==='open') payload=ui.render(user,'replay',{replay:action==='open'?interaction.values[0]:arg});
      else if (['cancel','confirmcancel','retry','rescore','pause','resume','void','unvoid'].includes(action)) payload=execute(user,action,{replay:arg});
      else throw new UserError('This button is not working. Open /help and try again.');
      return await present(interaction,payload,previous);
    } catch (err) {
      const message=err instanceof UserError ? err.message : 'Something went wrong. Try again or ask me for help.';
      if (!(err instanceof UserError)) log(`[discord] ${interaction.commandName || 'component'} failed: ${err.message}`);
      try {
        if (interaction.isAutocomplete()) { if (!interaction.responded) await interaction.respond([]); }
        else if (interaction.deferred || interaction.replied) await interaction.editReply({content:message,embeds:[],components:[],attachments:[],allowedMentions:{parse:[]}});
        else await interaction.reply({content:message,flags:MessageFlags.Ephemeral,allowedMentions:{parse:[]}});
      } catch (replyError) { log(`[discord] Could not deliver interaction response: ${replyError.message}`); }
    }
  };
}
