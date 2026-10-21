import {createHash} from 'node:crypto';
import config from '../config.js';
import {controlSchema,validateSettings} from './control-settings.js';

export class ControlStore {
  constructor(store){
    this.store=store;this.db=store.db;this.schema=controlSchema(config);
    this.db.exec(`CREATE TABLE IF NOT EXISTS bot_commands (id INTEGER PRIMARY KEY, action TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, finished_at INTEGER, result TEXT);
      CREATE TABLE IF NOT EXISTS bot_events (id INTEGER PRIMARY KEY, time INTEGER NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL);`);
  }
  read(key,fallback){const row=this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);return row?JSON.parse(row.value):fallback;}
  write(key,value){this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
  settings(){
    const values={...Object.fromEntries(this.schema.map(f=>[f.key,f.default])),...this.read('bot_settings',{})};
    const version=createHash('sha256').update(JSON.stringify(values)).digest('hex');return {values,version,schema:this.schema};
  }
  save(actor,version,patch){
    this.store.requireAdmin(actor);
    return this.store.transaction(()=>{
      const old=this.settings();if(version!==old.version)throw Object.assign(new Error('Settings changed in another tab. Reload before saving.'),{status:409});
      let values;try{values=validateSettings(this.schema,{...old.values,...patch});}catch(error){error.status=400;throw error;}
      this.write('bot_settings',values);this.store.log(actor,'bot-settings',{changes:Object.keys(values).filter(k=>JSON.stringify(values[k])!==JSON.stringify(old.values[k]))});return this.settings();
    });
  }
  setEnabled(value){const values=this.read('bot_settings',{});values['connection.enabled']=value;this.write('bot_settings',values);}
  status(){
    const value=this.read('bot_runtime',{}),now=Date.now();
    const serviceAvailable=Number.isFinite(value.heartbeat)&&value.heartbeat>0&&now-value.heartbeat<15000;
    const processor=value.processors?.control;
    const ready=!processor || (processor.lastCompletedAt>0&&now-processor.lastCompletedAt<15000&&!processor.error);
    return {...value,serviceAvailable,available:serviceAvailable&&ready};
  }
  publish(value){this.write('bot_runtime',{...value,heartbeat:Date.now()});}
  event(kind,message){
    this.db.prepare('INSERT INTO bot_events(time,kind,message) VALUES(?,?,?)').run(Date.now(),kind,String(message).slice(0,500));
    this.db.exec('DELETE FROM bot_events WHERE id <= (SELECT MAX(id)-300 FROM bot_events)');
  }
  events(){return this.db.prepare('SELECT * FROM bot_events ORDER BY id DESC LIMIT 100').all();}
  enqueue(actor,action,payload={}){
    this.store.requireAdmin(actor);
    if(payload.workerId!==undefined&&(typeof payload.workerId!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(payload.workerId)))throw Object.assign(new Error('Invalid recorder account.'),{status:400});
    if(!['connect','reconnect','disconnect','lobby','skip','retry-current'].includes(action))throw Object.assign(new Error('Unknown bot action.'),{status:400});
    const status=this.status();
    if(!status.available)throw Object.assign(new Error(status.serviceAvailable?'The command processor is not responding. Check the recorder service.':'The recorder process is offline. Start the Scority service first.'),{status:503});
    return this.store.transaction(()=>{
      if(this.db.prepare("SELECT id FROM bot_commands WHERE status IN ('pending','running') AND created_at>?").get(Date.now()-30000))throw Object.assign(new Error('Wait for the current bot action to finish.'),{status:409});
      const id=Number(this.db.prepare('INSERT INTO bot_commands(action,payload,created_at) VALUES(?,?,?)').run(action,JSON.stringify(payload),Date.now()).lastInsertRowid);
      this.store.log(actor,'bot-command',{id,action});return this.command(id);
    });
  }
  command(id){return this.db.prepare('SELECT id,action,status,created_at,finished_at,result FROM bot_commands WHERE id=?').get(id);}
  recover(){this.db.prepare("UPDATE bot_commands SET status='failed',result='Recorder restarted before this action completed.',finished_at=? WHERE status IN ('pending','running')").run(Date.now());}
  claim(){return this.store.transaction(()=>{
    this.db.prepare("UPDATE bot_commands SET status='failed',result='Action expired. Submit it again.',finished_at=? WHERE status='pending' AND created_at<?").run(Date.now(),Date.now()-30000);
    const row=this.db.prepare("SELECT * FROM bot_commands WHERE status='pending' ORDER BY id LIMIT 1").get();if(row)this.db.prepare("UPDATE bot_commands SET status='running' WHERE id=?").run(row.id);return row;
  });}
  finish(id,status,result){this.db.prepare('UPDATE bot_commands SET status=?,result=?,finished_at=? WHERE id=?').run(status,String(result).slice(0,500),Date.now(),id);}
}
