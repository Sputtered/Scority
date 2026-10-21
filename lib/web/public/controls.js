export function createControls({app,api,main,esc,toast,S}){
  let settings=null,polling=false;
  const when=t=>t?new Date(t).toLocaleString():'—';
  const views=['bot','settings','access','names','activity'];
  const header=(title,text)=>`<header class="topline"><div><p class="eyebrow">Scority controls</p><h1>${title}</h1><p class="subtitle">${text}</p></div><button data-action="refresh">Refresh</button></header>`;
  const action=(name,title,disabled=false,style='',workerId='')=>`<button class="${style}" data-bot-action="${name}" data-worker-id="${esc(workerId)}"${disabled?' disabled':''}>${title}</button>`;
  function status(data){
    const r=data.runtime,c=r.connection||{},rec=r.recorder||{},available=r.available,serviceAvailable=r.serviceAvailable??available,online=serviceAvailable&&c.state==='online';
    const allOnline=online&&(!r.workers?.length||r.workers.every(w=>w.connection.state==='online'));
    return `<div class="metrics"><div class="metric"><div><span>Minecraft connection</span><br><strong class="connection-state ${online?'online':''}">${esc(serviceAvailable?c.state:'Service offline')}</strong></div></div><div class="metric"><div><span>Replay queue</span><br><strong>${rec.queueSize??'—'}</strong> <span>${rec.paused?'paused':'in queue'}</span></div></div><div class="metric"><div><span>Discord</span><br><strong>${r.discord?.ready?'Online':'Offline'}</strong></div></div></div>
      ${!serviceAvailable?'<div class="notice">The recorder service has not reported in the last 15 seconds. Start the Scority service on the host to use connection controls.</div>':''}
      ${serviceAvailable&&!available?`<div class="notice">The bot is connected to its service, but connection controls are not responding. ${esc(r.processors?.control?.error||'Waiting for the command processor to recover.')}</div>`:''}
      ${r.processors?.recorder?.error?`<div class="notice">Replay processing: ${esc(r.processors.recorder.error)}</div>`:''}
      ${r.discordSettings?.error?`<div class="notice">Discord settings could not be applied: ${esc(r.discordSettings.error)}</div>`:r.discordSettings?.applying?'<div class="notice">Discord settings are applying. Connection controls remain available.</div>':''}
      <section class="panel"><div class="topline"><div><h2>Connection</h2><p class="subtitle">${esc(data.settings.values.targetHost)}:${data.settings.values.targetPort} · ${r.workers?.length>1?`${r.workers.filter(w=>w.connection.state==='online').length} / ${r.workers.length} accounts online`:esc(data.settings.values.mojangUsername)}</p></div><span class="badge ${online?'green':''}">${data.settings.values['connection.autoRejoin']?'AUTO REJOIN ON':'AUTO REJOIN OFF'}</span></div>
      <div class="actions">${action('connect','Connect',!available||allOnline,'primary')}${action('reconnect','Reconnect',!available)}${action('disconnect','Disconnect',!available,'danger')}<button data-auto-rejoin="${!data.settings.values['connection.autoRejoin']}">Turn auto rejoin ${data.settings.values['connection.autoRejoin']?'off':'on'}</button></div>
      <p class="subtitle control-help">Disconnect keeps the bot offline until you connect again. Reconnect restarts an active recording when interrupted-replay retries are enabled.</p>
      <dl class="status-grid"><div><dt>Connected since</dt><dd>${when(c.onlineSince)}</dd></div><div><dt>Next retry</dt><dd>${c.nextRetryAt?`${when(c.nextRetryAt)} · ${Math.max(0,Math.ceil((c.nextRetryAt-Date.now())/1000))}s`:'—'}</dd></div><div><dt>Connection attempts</dt><dd>${c.attempts??0}</dd></div><div><dt>Last packet</dt><dd>${when(c.lastPacketAt)}</dd></div><div><dt>Last disconnect</dt><dd>${esc(c.lastDisconnect?.reason||'None reported')}</dd></div><div><dt>Settings applied</dt><dd>${available&&r.settingsVersion===data.settings.version?'Up to date':'Waiting for recorder'}</dd></div><div><dt>Discord settings</dt><dd>${r.discordSettings?.error?'Needs attention':r.discordSettings?.applying?'Applying':r.discordSettings?.version===data.settings.version?'Up to date':'Waiting for Discord'}</dd></div></dl></section>
      <section class="panel"><div class="topline"><h2>Recorders</h2><button data-control-pause="${!rec.paused}">${rec.paused?'Resume queue':'Pause queue'}</button></div><p class="subtitle">Pause lets all current recordings finish. Connection controls above apply to all accounts.</p></section>
      ${(r.workers||[{id:'default',label:'Recorder',connection:c,recorder:rec}]).map(w=>{
        const recording=w.recorder||{},connected=serviceAvailable&&w.connection?.state==='online';
        return `<section class="panel"><div class="topline"><h2>${esc(w.label)}</h2><span class="badge ${connected?'green':''}">${esc(serviceAvailable?w.connection?.state:'Service offline')}</span></div><p>${recording.active?`Replay <strong>${esc(recording.active.replay_id)}</strong> &middot; attempt ${recording.active.attempts}`:'No replay is recording.'}</p><p class="subtitle">${recording.hud?`${esc(recording.hud.state)} &middot; ${recording.hud.elapsedSec??0} / ${recording.hud.totalSec??0} seconds &middot; ${recording.hud.speed??1}&times;`:esc(recording.lastError||'Waiting for the next replay.')}</p>${w.connection?.lastDisconnect?`<p class="subtitle">Last disconnect: ${esc(w.connection.lastDisconnect.reason)}</p>`:''}<div class="actions control-help">${action('retry-current','Restart this replay',!available||!connected||!recording.active,'',w.id)}${action('skip','Skip this replay',!available||!connected||!recording.active,'',w.id)}${action('lobby','Return to lobby',!available||!connected||Boolean(recording.active),'',w.id)}</div></section>`;
      }).join('')}
      <section class="panel"><h2>Connection events</h2>${events(data.events)}</section>`;
  }
  function events(rows){return rows.length?`<div class="table-wrap"><table><thead><tr><th>Time</th><th>Event</th><th>Details</th></tr></thead><tbody>${rows.map(e=>`<tr><td>${when(e.time)}</td><td>${esc(e.kind)}</td><td class="wrap">${esc(e.message)}</td></tr>`).join('')}</tbody></table></div>`:'<p class="subtitle">Connection events will appear here.</p>';}
  async function bot(){const data=await api('/api/control');settings=data.settings;main(header('Bot control','Connect, recover interrupted recordings, and see exactly why the bot went offline.')+'<div id="bot-status">'+status(data)+'</div>');}
  function field(f,value){
    const attr=`data-setting="${esc(f.key)}" id="setting-${esc(f.key)}"`;
    const input=f.type==='boolean'?`<select ${attr}><option value="true"${value?' selected':''}>On</option><option value="false"${!value?' selected':''}>Off</option></select>`:
      f.type==='select'?`<select ${attr}>${f.options.map(v=>`<option value="${v}"${v===value?' selected':''}>${v}</option>`).join('')}</select>`:
      f.type==='json'?`<textarea ${attr} rows="12" spellcheck="false">${esc(JSON.stringify(value,null,2))}</textarea>`:
      `<input ${attr} type="${f.type==='number'?'number':'text'}" ${f.type==='number'?`min="${f.min}" max="${f.max}" step="1"`:`maxlength="${f.maxLength}"`} value="${esc(value)}">`;
    return `<label class="setting-field" data-setting-label="${esc((f.group+' '+f.label+' '+f.key).toLowerCase())}"><span>${esc(f.label)}</span>${input}<small>${esc(f.apply||'Applies live')}</small></label>`;
  }
  function settingsForm(){
    const groups=[...new Set(settings.schema.map(f=>f.group))];
    main(header('All settings',`${settings.schema.length} controls for connection recovery, Minecraft, recording, automation, submissions, and Discord.`)+
      `<div class="toolbar"><input id="settings-search" type="search" placeholder="Find any setting…" aria-label="Find any setting"><button data-settings-export>Export settings</button><button data-settings-defaults>Load defaults</button></div><form id="control-settings">${groups.map(group=>`<section class="panel settings-group"><h2>${esc(group)}</h2><div class="settings-grid">${settings.schema.filter(f=>f.group===group).map(f=>field(f,settings.values[f.key])).join('')}</div></section>`).join('')}<div class="savebar"><span id="control-save-status">Settings are saved across restarts.</span><button class="primary" type="submit">Save settings</button></div></form>`);
  }
  async function settingsView(){settings=(await api('/api/control')).settings;settingsForm();}
  async function queue(){
    const [q,history]=await Promise.all([api('/api/queue'),api('/api/jobs')]);
    main(header('Replay queue','Add replays, pause processing, cancel waiting jobs, or retry failed recordings.')+
      `<section class="panel"><div class="topline"><h2>${q.paused?'Queue paused':'Queue running'} · ${q.jobs.length} jobs</h2><button class="primary" data-control-pause="${!q.paused}">${q.paused?'Resume queue':'Pause queue'}</button></div><form id="submit-replay" class="inline-form"><label>Replay ID<input name="replayId" placeholder="Replay ID or /replay …" required maxlength="200"></label><button type="submit">Add replay</button></form><p class="subtitle control-help">Pause lets all current recordings finish. Use Bot control to restart or skip the active replay.</p></section>
      <section class="panel"><h2>Waiting and recording</h2>${jobs(q.jobs.map(j=>({...j,replay_id:j.replayId})),true)}</section><section class="panel"><h2>Recent job history</h2><div class="toolbar"><input id="job-search" type="search" placeholder="Search replay, status, user, or error…" aria-label="Search jobs"></div>${jobs(history.jobs,false)}</section>`);
  }
  function jobs(rows,active){return rows.length?`<div class="table-wrap"><table><thead><tr><th>${active?'Position':'Job'}</th><th>Replay</th><th>Status</th><th>Details</th><th>Actions</th></tr></thead><tbody>${rows.map((j,i)=>`<tr data-job-search="${esc([j.replay_id,j.status,j.error,j.user_id].join(' ').toLowerCase())}"><td>${active?i+1:'R'+j.id}</td><td>${esc(j.replay_id)}</td><td><span class="badge">${esc(j.status)}</span></td><td class="wrap">${esc(j.error|| (j.priority?'Priority':j.rescore_requested_by||j.rescore?'Rescore':''))}${j.attempts?`<br><small>${j.attempts} attempt(s) · ${esc(j.user_id)}</small>`:''}</td><td>${j.status==='queued'?`<button data-job-action="cancel" data-id="${j.id}">Cancel</button>`:['failed','cancelled'].includes(j.status)?`<button data-job-action="retry" data-id="${j.id}">Retry</button>`:''}</td></tr>`).join('')}</tbody></table></div>`:'<p class="subtitle">No jobs here.</p>';}
  async function access(){
    const {users}=await api('/api/access');main(header('User controls','Manage priority placement, unlimited submissions, and daily usage.')+
      `<section class="panel"><form id="access-user" class="inline-form"><label>Discord user ID<input name="id" required pattern="[0-9]{17,20}" placeholder="Copy a Discord user ID"></label><label>Action<select name="action"><option value="priority">Grant priority</option><option value="unlimited">Grant unlimited submissions</option><option value="reset-limit">Reset today’s usage</option></select></label><button>Apply</button></form></section><section class="panel table-wrap"><table><thead><tr><th>Discord user ID</th><th>Usage today</th><th>Priority</th><th>Unlimited</th><th>Daily limit</th></tr></thead><tbody>${users.map(u=>`<tr><td>${esc(u.id)}</td><td>${u.quota.used} / ${u.quota.unlimited?'∞':u.quota.limit}</td><td><button data-user-action="priority" data-id="${u.id}" data-enabled="${!u.priority}">${u.priority?'Remove priority':'Grant priority'}</button></td><td><button data-user-action="unlimited" data-id="${u.id}" data-enabled="${!u.unlimited}">${u.unlimited?'Use daily limit':'Make unlimited'}</button></td><td><button data-user-action="reset-limit" data-id="${u.id}">Reset usage</button></td></tr>`).join('')}</tbody></table></section>`);
  }
  async function names(){
    const data=await api('/api/names');main(header('Names & reviews','Manage nicknames and alternate accounts, and review player corrections.')+
      `<section class="panel"><h2>Add a name link</h2><form id="name-link" class="inline-form"><label>Recorded name<input name="alias" required pattern="[A-Za-z0-9_]{1,16}"></label><label>Main name<input name="main" required pattern="[A-Za-z0-9_]{1,16}"></label><label>Type<select name="kind"><option value="nick">Nickname</option><option value="alt">Alternate account</option></select></label><button>Save link</button></form></section>
      <section class="panel"><h2>Name links</h2><div class="table-wrap"><table><thead><tr><th>Recorded name</th><th>Main name</th><th>Type</th><th>Action</th></tr></thead><tbody>${data.links.map(n=>`<tr><td>${esc(n.alias)}</td><td>${esc(n.main)}</td><td>${esc(n.kind)}</td><td><button data-name-action="unlink" data-alias="${esc(n.alias)}" data-kind="${n.kind}">Remove & revert</button></td></tr>`).join('')}</tbody></table></div></section>
      <section class="panel"><h2>Pending corrections · ${data.requests.length}</h2>${data.requests.map(r=>`<article class="review-request"><h3>G${r.game_id}: ${esc(r.original)} → ${esc(r.main)}</h3><p>${esc(r.reason)}</p><p class="subtitle">Requested by ${esc(r.user_id)}</p><div class="actions control-help"><button class="primary" data-name-action="approve" data-id="${r.id}">Approve</button><button data-name-action="reject" data-id="${r.id}">Reject</button></div></article>`).join('')||'<p class="subtitle">No corrections waiting.</p>'}</section>`);
  }
  async function activity(){const data=await api('/api/audit');main(header('Activity log','Recent changes to settings, jobs, access, names, and game results.')+`<section class="panel table-wrap"><table><thead><tr><th>Time</th><th>Action</th><th>Actor</th><th>Details</th></tr></thead><tbody>${data.entries.map(e=>`<tr><td>${when(e.created_at)}</td><td>${esc(e.action)}</td><td>${esc(e.actor)}</td><td class="wrap">${esc(e.detail)}</td></tr>`).join('')}</tbody></table></section>`);}
  async function open(view){if(view==='bot')await bot();if(view==='settings')await settingsView();if(view==='access')await access();if(view==='names')await names();if(view==='activity')await activity();}
  const post=(url,data)=>api(url,{method:'POST',body:JSON.stringify(data)});
  async function command(action,workerId){
    const queued=await post('/api/control/commands',{action,...(workerId?{workerId}:{})});toast('Action queued…');
    for(let i=0;i<40;i++){await new Promise(resolve=>setTimeout(resolve,750));const result=await api(`/api/control/commands/${queued.id}`);if(['succeeded','failed'].includes(result.status)){toast(result.result,result.status==='failed');if(S.view==='bot')await bot();return;}}
    toast('Action is still pending. Refresh to check the connection status.',true);
  }
  app.addEventListener('input',e=>{
    if(e.target.dataset.setting){S.dirty=true;document.querySelector('#control-save-status').textContent='Unsaved settings';}
    if(e.target.id==='settings-search'){for(const label of app.querySelectorAll('[data-setting-label]'))label.hidden=!label.dataset.settingLabel.includes(e.target.value.toLowerCase());for(const section of app.querySelectorAll('.settings-group'))section.hidden=![...section.querySelectorAll('[data-setting-label]')].some(e=>!e.hidden);}
    if(e.target.id==='job-search')for(const row of app.querySelectorAll('[data-job-search]'))row.hidden=!row.dataset.jobSearch.includes(e.target.value.toLowerCase());
  });
  app.addEventListener('submit',async e=>{
    if(!['control-settings','submit-replay','access-user','name-link'].includes(e.target.id))return;
    e.preventDefault();const button=e.target.querySelector('button[type="submit"],button');button.disabled=true;
    try{
      const input=Object.fromEntries(new FormData(e.target));
      if(e.target.id==='control-settings'){
        const values={};for(const el of e.target.querySelectorAll('[data-setting]')){const f=settings.schema.find(f=>f.key===el.dataset.setting);values[f.key]=f.type==='boolean'?el.value==='true':f.type==='number'||f.type==='select'&&typeof f.default==='number'?Number(el.value):f.type==='json'?JSON.parse(el.value):el.value;}
        settings=await api('/api/settings',{method:'PUT',body:JSON.stringify({version:settings.version,values})});S.dirty=false;settingsForm();toast('Settings saved. Timing changes apply at the next replay; server changes apply when reconnecting.');
      }
      if(e.target.id==='submit-replay'){await post('/api/jobs',{action:'submit',...input});await queue();toast('Replay queued.');}
      if(e.target.id==='access-user'){await post('/api/access',{...input,enabled:true});await access();toast('User updated.');}
      if(e.target.id==='name-link'){await post('/api/names',{action:'link',...input});await names();toast('Name link saved.');}
    }catch(error){toast(error.message,true);}finally{button.disabled=false;}
  });
  app.addEventListener('click',async e=>{
    const b=e.target.closest('button');if(!b)return;const d=b.dataset;
    if(!Object.keys(d).some(k=>['botAction','autoRejoin','controlPause','jobAction','userAction','nameAction','settingsDefaults','settingsExport'].includes(k)))return;
    b.disabled=true;
    try{
      if(d.botAction){if(['skip','retry-current','reconnect'].includes(d.botAction)&&!confirm('This can interrupt the current recording. Continue?'))return;await command(d.botAction,d.workerId);}
      if(d.autoRejoin){const fresh=(await api('/api/control')).settings;await api('/api/settings',{method:'PUT',body:JSON.stringify({version:fresh.version,values:{'connection.autoRejoin':d.autoRejoin==='true'}})});await bot();}
      if(d.controlPause){await post('/api/queue',{paused:d.controlPause==='true'});if(S.view==='queue')await queue();else await bot();}
      if(d.jobAction){await post('/api/jobs',{action:d.jobAction,id:Number(d.id)});await queue();}
      if(d.userAction){await post('/api/access',{action:d.userAction,id:d.id,enabled:d.enabled==='true'});await access();}
      if(d.nameAction){if(d.nameAction==='unlink'&&!confirm('Remove this link and revert affected names?'))return;await post('/api/names',{action:d.nameAction,id:d.id,alias:d.alias,kind:d.kind});await names();}
      if('settingsDefaults'in d){if(!confirm('Replace the form with default settings? You still need to save.'))return;settings.values=Object.fromEntries(settings.schema.map(f=>[f.key,f.default]));settingsForm();S.dirty=true;document.querySelector('#control-save-status').textContent='Defaults loaded — save to apply';}
      if('settingsExport'in d){const url=URL.createObjectURL(new Blob([JSON.stringify(settings.values,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='scority-settings.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
    }catch(error){toast(error.message,true);}finally{b.disabled=false;}
  });
  setInterval(async()=>{if(S.view!=='bot'||!S.csrf||polling||!document.querySelector('#bot-status'))return;polling=true;try{const data=await api('/api/control');const target=document.querySelector('#bot-status');if(S.view==='bot'&&target)target.innerHTML=status(data);}catch{}finally{polling=false;}},3000);
  return {views,open,queue};
}
