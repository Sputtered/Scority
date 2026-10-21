import { Client, GatewayIntentBits, Events, ActivityType } from 'discord.js';
import { DiscordUI } from './ui.js';
import { CompletionNotifier, NameRequestNotifier } from './notifications.js';
import { createInteractionHandler } from './interactions.js';
import { ImageCards } from './cards/service.js';
import { RecentPublisher,findRecentMessage,editRecentMessage } from './recent.js';

export async function startBot({token,store,recorder,control}) {
  const client=new Client({intents:[GatewayIntentBits.Guilds],allowedMentions:{parse:[]}});
  const ui=new DiscordUI(store,recorder);
  const cards=new ImageCards({store,style:process.env.REPLAY_CARD_STYLE || 'inventory',
    submitterName:async id=>{const user=await client.users.fetch(id);return user.globalName || user.username;},
    playerStyle:process.env.REPLAY_PLAYER_CARD_STYLE || process.env.REPLAY_CARD_STYLE || 'inventory',
    gameStyle:process.env.REPLAY_GAME_CARD_STYLE || process.env.REPLAY_CARD_STYLE || 'inventory'});
  client.on(Events.InteractionCreate,createInteractionHandler({store,ui,cards}));
  client.on(Events.Error,err=>console.error(`[discord] Connection error: ${err.message}`));
  client.once(Events.ClientReady,ready=>{
    console.log(`[discord] Connected as ${ready.user.tag}. Open /help in Discord.`);
    ready.user.setActivity('/help · Scority',{type:ActivityType.Watching});
  });
  try { await client.login(token); } catch (err) { await client.destroy(); throw err; }
  const notifications=new CompletionNotifier({store,cards,send:(user,payload)=>client.users.send(user,payload)});
  const requests=new NameRequestNotifier({store,send:(user,payload)=>client.users.send(user,payload)});
  const makeRecent=channelId=>new RecentPublisher({store,cards,channelId,
    send:async(id,payload)=>{const channel=await client.channels.fetch(id);return channel.send(payload);},
    edit:async(id,post,payload)=>editRecentMessage(await client.channels.fetch(id),post,client.user.id,payload),
    findSent:async post=>findRecentMessage(await client.channels.fetch(post.channel_id),post,client.user.id)});
  let recent=null,shuttingDown=false;
  if(control){
    control.discordStatus=()=>({ready:client.isReady(),username:client.user?.tag,ping:client.ws.ping});
    control.applyDiscord=async v=>{
      if(shuttingDown || control.stopped)return;
      cards.style=v['discord.style'];cards.playerStyle=v['discord.playerStyle'];cards.gameStyle=v['discord.gameStyle'];
      for(const [worker,enabled]of [[notifications,v['discord.completionNotifications']],[requests,v['discord.nameNotifications']]]){
        if(enabled)worker.start();else if(worker.timer)await worker.stop();
        if(shuttingDown || control.stopped)return;
      }
      const channelId=v['discord.recentChannelId'];
      if(recent&&recent.channelId!==channelId){await recent.stop();recent=null;}
      if(shuttingDown || control.stopped)return;
      if(channelId&&v['discord.recentEnabled']){recent||=makeRecent(channelId);recent.start();}else if(recent?.timer)await recent.stop();
    };
    await control.applyDiscord(control.values);
  }else{
    if(process.env.REPLAY_RECENT_CHANNEL_ID)recent=makeRecent(process.env.REPLAY_RECENT_CHANNEL_ID);
    notifications.start();requests.start();recent?.start();
  }
  return {
    client,
    async destroy() { shuttingDown=true;await Promise.all([notifications.stop(),requests.stop(),recent?.stop()]); await client.destroy(); },
  };
}
