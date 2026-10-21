import {flattenToText} from './death-parser.js';

const reasonText=value=>{try{return flattenToText(typeof value==='string'?JSON.parse(value):value)||String(value);}catch{return String(value||'Connection closed');}};

// serialize retries to prevent parallel logins
export class ManagedConnection {
  constructor({connect,settings,now=()=>Date.now(),random=Math.random,event=()=>{}}){
    Object.assign(this,{connectSession:connect,settings,now,random,event});
    this.client=null;this.state='offline';this.attempts=0;this.nextRetryAt=null;this.lastDisconnect=null;this.onlineSince=null;this.lastPacketAt=null;this.stopped=false;this.force=false;this.hasAttempted=false;
  }
  request(action){
    if(action==='disconnect'){this.force=false;this.nextRetryAt=null;this.close('Disconnected from the dashboard');return;}
    if(action==='connect'&&this.client)return;
    if(action==='reconnect')this.close('Reconnect requested from the dashboard');
    this.attempts=0;this.force=true;this.nextRetryAt=this.now();
  }
  close(reason){
    const client=this.client;if(!client)return;
    // finalize before reconnecting
    this.client=null;this.state='offline';this.onlineSince=null;
    this.lastDisconnect={reason,time:this.now()};this.event('disconnect',reason);
    this.session?.close?.(reason);
    client.end(reason);client.socket?.destroy();
  }
  watch(session){
    const client=session.client||session;this.session=session;
    this.client=client;this.state='connecting';this.connectStartedAt=this.now();this.lastPacketAt=this.now();this.onlineSince=null;
    const lost=reason=>{
      if(this.client!==client)return;
      this.close(reasonText(reason));
      const cfg=this.settings();
      if(!this.stopped&&cfg['connection.enabled']&&cfg['connection.autoRejoin']){
        const base=Math.min(cfg['connection.maxRetryDelayMs'],cfg['connection.retryDelayMs']*2**Math.min(16,Math.max(0,this.attempts-1)));
        this.nextRetryAt=this.now()+Math.min(cfg['connection.maxRetryDelayMs'],Math.round(base*(1+this.random()*0.2)));this.state='waiting';
      }
    };
    client.on('packet',()=>{if(this.client===client)this.lastPacketAt=this.now();});
    client.on('connect',()=>{if(this.client!==client){client.end();client.socket?.destroy();}});
    client.on('position',()=>{if(this.client===client&&this.state!=='online'){this.state='online';this.onlineSince=this.now();this.nextRetryAt=null;this.event('connected','Minecraft spawned successfully.');}});
    for(const name of ['kick_disconnect','disconnect'])client.on(name,data=>lost(data.reason));
    client.on('error',error=>lost(error.message));client.on('end',reason=>lost(reason||'Connection ended'));
  }
  tick(){
    if(this.stopped)return;
    const cfg=this.settings(),now=this.now();
    if(!cfg['connection.enabled']){this.wasEnabled=false;this.force=false;this.nextRetryAt=null;this.close('Connection disabled');this.state='offline';return;}
    if(this.wasEnabled===false)this.force=true;
    this.wasEnabled=true;
    if(this.client){
      if(this.state==='connecting'&&now-this.connectStartedAt>=cfg['connection.connectTimeoutMs'])this.client.emit('error',new Error('Login / spawn timed out'));
      else if(now-this.lastPacketAt>=cfg['connection.idleTimeoutMs'])this.client.emit('error',new Error('No packets received; connection timed out'));
      else if(this.state==='online'&&now-this.onlineSince>=cfg['connection.stableMs'])this.attempts=0;
      return;
    }
    if(!this.force&&!cfg['connection.autoRejoin']&&this.hasAttempted){this.nextRetryAt=null;this.state='offline';return;}
    if(this.nextRetryAt!==null&&now<this.nextRetryAt)return;
    this.force=false;this.nextRetryAt=null;this.attempts++;this.hasAttempted=true;
    this.event('connecting',`Connecting to ${cfg.targetHost}:${cfg.targetPort} (attempt ${this.attempts}).`);
    try{this.watch(this.connectSession());}
    catch(error){this.lastDisconnect={reason:error.message,time:now};this.event('error',error.message);this.state='waiting';this.nextRetryAt=now+cfg['connection.maxRetryDelayMs'];}
  }
  status(){return {state:this.state,attempts:this.attempts,nextRetryAt:this.nextRetryAt,lastDisconnect:this.lastDisconnect,onlineSince:this.onlineSince,lastPacketAt:this.lastPacketAt};}
  stop(){this.stopped=true;this.nextRetryAt=null;this.close('Recorder shutting down');this.state='offline';}
}
