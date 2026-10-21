import {RecorderBridge} from './recorder.js';

export class RecorderPool {
  constructor(store,accounts) {
    if (!accounts.length) throw new Error('At least one recorder account is required.');
    this.store=store;
    this.workers=accounts.map(account=>({...account,recorder:new RecorderBridge(store,{workerId:account.id})}));
  }
  async tick() {
    const results=await Promise.allSettled(this.workers.map(worker=>worker.recorder.tick()));
    const errors=results.filter(result=>result.status==='rejected').map(result=>result.reason);
    if(errors.length)throw new AggregateError(errors,errors.map(error=>error.message).join('; '));
  }
  status() {
    const workers=this.workers.map(({id,label,recorder})=>({id,label,...recorder.status()}));
    const active=workers.find(worker=>worker.active);
    return {connection:workers.some(worker=>worker.connection==='online')?'online':workers.some(worker=>worker.connection==='connecting')?'connecting':'offline',
      paused:this.store.paused(),active:active?.active||null,hud:active?.hud||null,
      lastError:workers.find(worker=>worker.lastError)?.lastError||null,
      broken:workers.every(worker=>worker.broken),queueSize:this.store.queue().length,workers};
  }
}
