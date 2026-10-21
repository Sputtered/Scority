import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {Client,GatewayIntentBits,AttachmentBuilder} from 'discord.js';
import {damageMessage} from '../lib/discord/damage-report.js';

const {values,positionals}=parseArgs({allowPositionals:true,options:{'update-existing':{type:'boolean',default:false}}});
const [channelId,...files]=positionals,update=values['update-existing'];
if(!/^\d{17,20}$/.test(channelId??'') || !files.length)throw Error('Usage: post-damage-trial.js [--update-existing] <channel> <report.json> [...]');
const reports=files.map(filename=>({filename,...damageMessage(JSON.parse(fs.readFileSync(filename,'utf8')))}));
if(new Set(reports.map(r=>r.name)).size!==reports.length)throw Error('Duplicate report attachment names');
const client=new Client({intents:[GatewayIntentBits.Guilds],allowedMentions:{parse:[]}});
try {
  await client.login(process.env.DISCORD_TOKEN);
  const channel=await client.channels.fetch(channelId);
  // reconcile attachments before retrying
  const existing=new Map(),wanted=new Set(reports.map(r=>r.name));let before;
  for(;;){const page=await channel.messages.fetch({limit:100,...(before?{before}:{})});if(!page.size)break;
    for(const m of page.values())if(m.author.id===client.user.id)for(const a of m.attachments.values())if(wanted.has(a.name)){
      if(existing.has(a.name))throw Error(`Multiple existing messages for ${a.name}; review before posting`);
      existing.set(a.name,m.id);
    }
    if(page.size<100)break;before=[...page.keys()].reduce((a,b)=>BigInt(a)<BigInt(b)?a:b);
  }
  if(update)for(const {name} of reports)if(!existing.has(name))throw Error(`Cannot update missing report ${name}`);
  for(const {filename,name,text,embeds} of reports) {
    if(existing.has(name) && !update){console.log(JSON.stringify({file:filename,id:existing.get(name),alreadySent:true}));continue;}
    const payload={embeds,files:[new AttachmentBuilder(Buffer.from(text),{name})],allowedMentions:{parse:[]}};
    const message=update
      ? await (await channel.messages.fetch(existing.get(name))).edit({...payload,attachments:[]})
      : await channel.send({...payload,nonce:createHash('sha256').update(`damage:${channelId}:${name}`).digest('hex').slice(0,24),enforceNonce:true});
    fs.writeFileSync(path.join(path.dirname(filename),path.basename(filename,'.json')+'.sent.json'),JSON.stringify({channelId,messageId:message.id,report:filename,experiment:'damage-v2',...(update?{updatedAt:new Date().toISOString()}:{})}));
    console.log(JSON.stringify({file:filename,id:message.id,updated:update}));existing.set(name,message.id);
  }
} finally {await client.destroy();}
