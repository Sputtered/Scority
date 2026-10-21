import {TEAM_NAMES,teamLabel} from '../team-colors.js';
import { SlashCommandBuilder, ApplicationIntegrationType, InteractionContextType } from 'discord.js';
const command = (name,description) => new SlashCommandBuilder().setName(name).setDescription(description)
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall,ApplicationIntegrationType.UserInstall)
  .setContexts(InteractionContextType.Guild,InteractionContextType.BotDM,InteractionContextType.PrivateChannel);
const text = (c,name,description,{required=true,autocomplete=false,max=100}={}) => c.addStringOption(o=>o.setName(name).setDescription(description)
  .setRequired(required).setMaxLength(max).setAutocomplete(autocomplete));
const player = (c,name='user') => text(c,name,'Minecraft player name',{autocomplete:true,max:16});
const replay = c => text(c,'replay','Replay ID or a number like R00001 or G00001',{autocomplete:true});
const removeLink = (name,kind) => player(command(name,`Owner: remove a ${kind} link`),'name')
  .addBooleanOption(o=>o.setName('revert').setDescription('True: undo past changes (default). False: keep past names; stop linking future games'));
export const commands = [
  command('help','See what the bot can do'),
  text(command('submit','Add a replay to the queue (5 a day)'),'replay','Replay ID or /replay <id>',{required:false,max:110}),
  command('queue','See which replays are being scored or waiting'),
  command('status','See how your replay and the queue are doing'),
  command('limit','See how many replays you can still add today'),
  command('recentgames','See the latest scored games'),
  command('myreplays','See all the replays you added'),
  player(command('replays','Find games with a Minecraft player')),
  replay(command('replay','See a replay’s score or place in the queue')),
  player(command('stats','See a player’s wins, kills, deaths, and more')),
  player(player(command('matchup','See who won and who got more kills against each other'),'user1'),'user2'),
  player(player(command('compare','Compare two players’ stats'),'user1'),'user2'),
  player(command('rivals','See who a player faces the most')),
  player(command('teammates','See who a player teams up with and how often they win')),
  command('leaderboard','See the top 10 for K/D, W/L, or replays submitted')
    .addStringOption(o=>o.setName('metric').setDescription('Choose a top 10 list').addChoices(
      {name:'K/D ratio',value:'kd'},{name:'W/L ratio',value:'wl'},{name:'Replays submitted',value:'submissions'}))
    .addIntegerOption(o=>o.setName('minimum_games').setDescription('Minimum games for K/D and W/L lists only').setMinValue(1).setMaxValue(10000)),
  replay(command('export','Download a replay’s results')),
  replay(command('cancel','Remove one of your waiting replays')),
  text(replay(command('void','Owner: void a game and remove it from stats')),'reason','Why are you voiding this game?',{required:false,max:200}),
  replay(command('unvoid','Owner: restore a voided game')),
  command('priority','Owner: manage priority users, or list them')
    .addUserOption(o=>o.setName('user').setDescription('Discord user to update'))
    .addBooleanOption(o=>o.setName('enabled').setDescription('True: grant priority (default). False: remove priority')),
  text(command('resetlimit','Owner: reset someone’s five daily replay spots'),'id','Discord user ID',{max:24}),
  command('nolimit','Owner: remove or restore a user’s daily submission limit')
    .addUserOption(o=>o.setName('user').setDescription('Discord user to update').setRequired(true))
    .addBooleanOption(o=>o.setName('enabled').setDescription('True: unlimited until revoked (default). False: restore the daily limit')),
  replay(command('retry','Owner: try a replay again')),
  replay(command('rescore','Owner: record a saved game again and refresh its results')),
  command('pause','Owner: pause after this replay finishes'),
  command('resume','Owner: start the queue again'),
  text(replay(command('setwinner','Owner: set the winner of a game'))
    .addStringOption(o=>o.setName('team').setDescription('Winning team').setRequired(true).addChoices(
      ...TEAM_NAMES.map(value=>({name:teamLabel(value),value})),{name:'Not sure',value:'unknown'})),
    'reason','Why are you changing the winner?',{required:false,max:200}),
  command('admin','Owner: manage the bot and queue'),
  command('audit','Owner: see recent changes'),
  player(player(command('nickadd','Owner: link a nick to a main name in past and future games'),'nick'),'main'),
  removeLink('nickremove','nick'),
  player(player(command('alt','Owner: link an alt used by one person in past and future games'),'alt'),'main'),
  removeLink('altremove','alt'),
  text(command('names','See saved nick and alt links'),'user','Main name, nick, or alt (leave empty for all)',{required:false,autocomplete:true,max:16}),
  player(player(replay(command('setname','Owner: change a player’s name for just one game')),'user'),'main'),
  player(replay(command('resetname','Owner: undo a name change for just one game')))
    .addStringOption(o=>o.setName('mode').setDescription('Use the original name by default, or follow saved nick and alt links').addChoices(
      {name:'Use the original replay name',value:'original'},{name:'Follow saved nick and alt links',value:'follow'})),
  command('requests','Owner: review requests to change names in games'),
  command('myrequests','See your name change requests and whether they were approved'),
].map(c=>c.toJSON());
export const ADMIN_COMMANDS = new Set(['whitelist','unwhitelist','whitelisted','priority','resetlimit','nolimit','retry','rescore','pause','resume','setwinner','admin','audit',
  'nickadd','nickremove','alt','altremove','setname','resetname','requests','request','approvename','rejectname','void','unvoid']);
