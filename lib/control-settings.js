export function controlSchema(config) {
  const fields=[];
  const add=(key,label,type,value,group,extra={})=>fields.push({key,label,type,default:value,group,...extra});
  const bool=(key,label,value,group,extra)=>add(key,label,'boolean',value,group,extra);
  const num=(key,label,value,min,max,group,extra)=>add(key,label,'number',value,group,{min,max,...extra});
  const select=(key,label,value,options,group,extra)=>add(key,label,'select',value,group,{options,...extra});
  bool('connection.enabled','Connect on startup / keep connection enabled',true,'Connection');
  bool('connection.autoRejoin','Automatically rejoin after disconnects',true,'Connection');
  num('connection.retryDelayMs','Initial retry delay (ms)',10000,1000,600000,'Connection');
  num('connection.maxRetryDelayMs','Maximum retry delay (ms)',120000,1000,3600000,'Connection');
  num('connection.connectTimeoutMs','Login / spawn timeout (ms)',120000,10000,600000,'Connection');
  num('connection.idleTimeoutMs','No packets timeout (ms)',90000,10000,600000,'Connection');
  num('connection.stableMs','Healthy connection before resetting retries (ms)',60000,1000,600000,'Connection');
  add('targetHost','Minecraft server','text',config.targetHost,'Minecraft',{maxLength:253,apply:'Next connection'});
  num('targetPort','Minecraft port',config.targetPort,1,65535,'Minecraft',{apply:'Next connection'});
  add('mojangUsername','Microsoft account / cache identity','text',config.mojangUsername,'Minecraft',{maxLength:254,apply:'Next connection; a new account may require terminal sign-in'});
  select('protocolVersion','Minecraft version',config.protocolVersion,['1.8.9'],'Minecraft',{apply:'Next connection'});
  num('client.viewDistance','View distance (chunks)',16,2,32,'Minecraft',{apply:'Next connection'});
  bool('onlyRecordWhilePlaying','Record events only while replay is playing',config.onlyRecordWhilePlaying,'Scoring',{apply:'Next replay'});
  add('teamColors','Team color aliases','json',config.teamColors,'Scoring',{apply:'Next replay'});
  bool('recorder.retryInterrupted','Requeue recordings interrupted by a disconnect',true,'Recorder');
  num('recorder.maxDisconnectRetries','Disconnect retries per replay',5,0,100,'Recorder');
  num('recorder.loadTimeoutMs','Replay load timeout (ms)',120000,5000,600000,'Recorder');
  num('recorder.maxLoadRetries','Retries when a replay does not load',1,0,5,'Recorder');
  num('recorder.recordingTimeoutMs','Maximum recording time (ms)',5400000,60000,43200000,'Recorder');
  for(const [key,label,min,max] of [
    ['postSpawnDelayMs','Wait after spawn (ms)',0,120000],['postCommandDelayMs','Wait after /replay (ms)',0,120000],
    ['postLobbyDelayMs','Wait after /lobby (ms)',0,120000],['menuSlot','Controls hotbar slot (0–8)',0,8],
    ['rightClickCount','Controls right clicks',0,20],['rightClickIntervalMs','Time between clicks (ms)',100,10000],
    ['speedSlot','Playback hotbar slot (0–8)',0,8],['speedSlotClickCount','Playback right clicks',0,20],
    ['betweenReplaysDelayMs','Wait between replays (ms)',0,120000],['movementIntervalMs','Anti-idle interval (ms; 0 disables)',0,3600000],
    ['movementHoldMs','Anti-idle movement duration (ms)',0,10000],
  ])num(`automation.${key}`,label,config.automation[key],min,max,'Replay automation',{apply:'Next replay / connection'});
  select('automation.replaySpeed','Replay speed',config.automation.replaySpeed,[0.25,0.5,1,2,4],'Replay automation',{apply:'Next replay'});
  bool('submissions.enabled','Accept replay submissions',true,'Submissions');
  num('submissions.dailyLimit','Daily replay limit per person',5,1,10000,'Submissions');
  for(const [key,label,env] of [['style','Default card style','REPLAY_CARD_STYLE'],['playerStyle','Player card style','REPLAY_PLAYER_CARD_STYLE'],['gameStyle','Game card style','REPLAY_GAME_CARD_STYLE']])
    select(`discord.${key}`,label,process.env[env]||process.env.REPLAY_CARD_STYLE||'inventory',['inventory','carbon','arena','studio','off'],'Discord');
  bool('discord.completionNotifications','Send completion notifications',true,'Discord');
  bool('discord.nameNotifications','Send name review notifications',true,'Discord');
  bool('discord.recentEnabled','Publish and refresh recent games',true,'Discord');
  add('discord.recentChannelId','Recent games channel ID','text',process.env.REPLAY_RECENT_CHANNEL_ID||'','Discord',{maxLength:20,apply:'Live; changing channel starts publishing there'});
  return fields;
}

export function validateSettings(schema,values) {
  if(!values||typeof values!=='object'||Array.isArray(values))throw new Error('Settings must be an object.');
  const result={};
  for(const [key,value] of Object.entries(values)){
    const f=schema.find(f=>f.key===key);if(!f)throw new Error(`Unknown setting: ${key}`);
    if(f.type==='boolean'&&typeof value!=='boolean')throw new Error(`${f.label}: choose on or off.`);
    if(f.type==='number'&&(!Number.isInteger(value)||value<f.min||value>f.max))throw new Error(`${f.label}: enter a whole number between ${f.min} and ${f.max}.`);
    if(f.type==='select'&&!f.options.includes(value))throw new Error(`${f.label}: choose a supported value.`);
    if(f.type==='text'&&(typeof value!=='string'||value.length>f.maxLength||/[\r\n\x00]/.test(value)))throw new Error(`${f.label}: invalid text.`);
    if(['targetHost','mojangUsername'].includes(key)&&!value.trim())throw new Error(`${f.label} is required.`);
    if(key==='targetHost'&&!/^[a-zA-Z0-9.:-]+$/.test(value))throw new Error('Enter a hostname or IP address.');
    if(key==='discord.recentChannelId'&&value&&!/^\d{17,20}$/.test(value))throw new Error('Enter a Discord channel ID.');
    if(key==='teamColors'){
      const teams=Object.keys(f.default);
      if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==teams.length||teams.some(t=>!Array.isArray(value[t])||!value[t].length||value[t].length>20||value[t].some(c=>typeof c!=='string'||!/^#?[a-zA-Z0-9_]{1,32}$/.test(c))))throw new Error('Team colors must provide an array of color names for every team.');
    }
    result[key]=value;
  }
  if(result['connection.maxRetryDelayMs']<result['connection.retryDelayMs'])throw new Error('Maximum retry delay must be at least the initial delay.');
  return result;
}
