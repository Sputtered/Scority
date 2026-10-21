import config from '../../config.js';
import {ControlStore} from '../control-store.js';
import {ManagedConnection} from '../managed-connection.js';

export class BotControl {
  constructor(store,recorder){
    this.store=store;this.recorder=recorder;this.data=new ControlStore(store);this.data.recover();
    this.workers=recorder.workers||[{id:'default',label:'Recorder',recorder}];
    this.stopped=false;this.processors={control:{lastCompletedAt:0,error:null},recorder:{lastCompletedAt:0,error:null}};
    this.discordAppliedVersion=null;this.discordSettingsError=null;this.discordTask=null;this.pendingDiscord=null;
    const settings=this.data.settings();this.values=settings.values;this.appliedVersion=settings.version;this.apply();
  }
  bind(connect){
    for(const worker of this.workers)worker.connection=new ManagedConnection({connect:()=>connect(worker),settings:()=>this.values,
      event:(kind,message)=>this.data.event(kind,`${worker.label}: ${message}`)});
    this.connection=this.workers[0].connection;
  }
  apply(){
    const v=this.values;
    for(const key of ['targetHost','targetPort','mojangUsername','protocolVersion','onlyRecordWhilePlaying','teamColors'])config[key]=v[key];
    for(const key of Object.keys(config.automation))if(Object.hasOwn(v,`automation.${key}`))config.automation[key]=v[`automation.${key}`];
    for(const {recorder} of this.workers){
      recorder.loadTimeoutMs=v['recorder.loadTimeoutMs'];recorder.recordingTimeoutMs=v['recorder.recordingTimeoutMs'];
      recorder.maxLoadRetries=v['recorder.maxLoadRetries'];
      recorder.retryInterrupted=v['recorder.retryInterrupted'];recorder.maxDisconnectRetries=v['recorder.maxDisconnectRetries'];
      if(recorder.automator&&!recorder.activeJob){
        const bot=recorder.automator,changed=bot.cfg.movementIntervalMs!==config.automation.movementIntervalMs;
        bot.cfg={...config.automation};if(changed&&bot.started&&!bot.stopped){bot._stopMovementGuard();bot._startMovementGuard();}
      }
    }
  }
  async execute(action,{workerId}={}){
    if(!this.connection)throw new Error('Connection controller is not ready.');
    const worker=workerId?this.workers.find(worker=>worker.id===workerId):this.workers.length===1?this.workers[0]:null;
    if(workerId&&!worker)throw new Error('Recorder account not found. Refresh the page.');
    if(['connect','reconnect','disconnect'].includes(action)){
      if(workerId)throw new Error('Connection controls apply to all accounts. Use Restart current replay to reconnect one account.');
      this.data.setEnabled(action!=='disconnect');this.values=this.data.settings().values;this.apply();
      for(const {connection} of this.workers){connection.request(action);connection.tick();}
      return action==='disconnect'?'Disconnected. Automatic reconnect is suspended until you connect again.':'Connection requested. Watch connection status for the result.';
    }
    if(!worker)throw new Error('Choose the recorder account for this action.');
    const {recorder,connection}=worker;
    const bot=recorder.automator;if(!bot||connection.state!=='online')throw new Error('Minecraft is not connected.');
    if(action==='lobby'){
      if(recorder.activeJob)throw new Error('A replay is recording. Skip or retry it before returning to the lobby.');
      bot.sendChat('/lobby');return 'Sent /lobby.';
    }
    if(!recorder.activeJob)throw new Error('No replay is recording.');
    if(action==='skip'){
      recorder.fail('Skipped from the dashboard.');
      void bot.skipCurrent().catch(error=>{this.data.event('error',error.message);bot.onConnectionError(error);});
      return 'Replay skipped. It can be retried from the queue history.';
    }
    if(action==='retry-current'){
      recorder.requeue('Restarted from the dashboard.');connection.request('reconnect');connection.tick();return 'Current replay requeued; reconnecting.';
    }
  }
  recordProcessor(name,error=null){this.processors[name]={lastCompletedAt:Date.now(),error:error?String(error.message||error):null};}
  refreshDiscord(settings){
    if(!this.applyDiscord || this.stopped)return;
    // keep commands responsive during edits
    this.pendingDiscord=settings;
    if(this.discordTask)return;
    if(this.discordAppliedVersion===settings.version){this.pendingDiscord=null;return;}
    this.discordTask=(async()=>{
      while(this.pendingDiscord && !this.stopped){
        const requested=this.pendingDiscord;this.pendingDiscord=null;
        if(requested.version===this.discordAppliedVersion)continue;
        try{
          await this.applyDiscord(requested.values);
          this.discordAppliedVersion=requested.version;this.discordSettingsError=null;
        }catch(error){
          this.discordSettingsError=String(error.message||error);
          if(this.stopped)return;
          this.data.event('error',`Could not apply Discord settings: ${this.discordSettingsError}`);
          break;
        }
      }
    })().finally(()=>{this.discordTask=null;});
  }
  publish(){
    const workers=this.workers.map(({id,label,recorder,connection})=>({id,label,connection:connection?.status()||{state:'starting'},recorder:recorder.status()}));
    const connection=(workers.find(worker=>worker.connection.state==='online')||workers[0]).connection;
    this.data.publish({connection,workers,recorder:this.recorder.status(),settingsVersion:this.appliedVersion,discord:this.discordStatus?.()||null,
      processors:this.processors,discordSettings:{version:this.discordAppliedVersion,applying:Boolean(this.discordTask),error:this.discordSettingsError}});
  }
  pulse(){
    if(this.stopped)return;
    for(const {recorder,connection} of this.workers){
      if(recorder.automator?.broken&&connection?.client&&this.values['connection.autoRejoin'])connection.client.emit('error',new Error('Replay automation stopped; reconnecting to recover.'));
      connection?.tick();
    }
    this.publish();
  }
  async tick(){
    if(this.stopped)return;
    try{
      const settings=this.data.settings();this.values=settings.values;this.apply();
      this.refreshDiscord(settings);this.appliedVersion=settings.version;
      const command=this.data.claim();
      if(command){try{this.data.finish(command.id,'succeeded',await this.execute(command.action,JSON.parse(command.payload)));}catch(error){this.data.finish(command.id,'failed',error.message);}}
      this.recordProcessor('control');this.publish();
    }catch(error){this.recordProcessor('control',error);throw error;}
  }
  stop(){if(this.stopped)return;this.stopped=true;this.pendingDiscord=null;for(const {connection} of this.workers)connection?.stop();this.publish();this.data.write('bot_runtime',{...this.data.read('bot_runtime',{}),heartbeat:0});}
}
