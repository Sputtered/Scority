import { UserError, MIN_REPLAY_SECONDS, SHORT_REPLAY_REASON } from "./store.js";
import { flattenToText } from '../death-parser.js';
export class RecorderBridge {
  constructor(store, { workerId = 'default', loadTimeoutMs = 120_000, maxLoadRetries = 1, recordingTimeoutMs = 90*60_000, now = () => Date.now(), log = console.log } = {}) {
    this.workerId=workerId;
    this.store=store; this.now=now; this.log=log;
    this.loadTimeoutMs=loadTimeoutMs; this.recordingTimeoutMs=recordingTimeoutMs;
    this.maxLoadRetries=maxLoadRetries;
    this.automator=null; this.activeJob=null; this.hud=null;
    this.connection='offline'; this.lastError=null; this.startedAt=null; this.seenReplay=false;
    const self=this;
    this.queue={
      get length() { return self.store.paused() ? 0 : self.store.queue().filter(j=>j.status==='queued').length; },
      shift() {
        const job=self.store.claimNext(self.workerId);
        if (!job) return null;
        self.activeJob=job; self.startedAt=self.now(); self.hud=null; self.seenReplay=false; self.lastError=null;
        return {command:`/replay ${job.replay_id}`,replayId:job.replay_id,submissionId:job.id};
      },
    };
  }
  attach(automator) { this.automator=automator; automator.queue=this.queue; this.connection='connecting'; }
  spawned() { this.connection='online'; }
  progress(hud) {
    if (!this.activeJob) return false;
    if (['playing','paused'].includes(hud.state) && Number.isFinite(hud.totalSec) && hud.totalSec>0 && hud.totalSec<MIN_REPLAY_SECONDS) {
      this.store.invalidate(this.activeJob.id,SHORT_REPLAY_REASON);
      this.activeJob=null;this.startedAt=null;this.hud=null;this.seenReplay=false;this.lastError=SHORT_REPLAY_REASON;
      void this.automator?.skipCurrent().catch(err=>this.log(`[discord] Could not skip short replay: ${err.message}`));
      return false;
    }
    this.hud=hud;
    if (['playing','paused'].includes(hud.state)) this.seenReplay=true;
    return true;
  }
  complete(payload) {
    if (!this.activeJob) return null;
    const job=this.activeJob;
    try {
      const game=this.store.complete(job.id,payload);
      if (game) this.log(`[discord] ${job.replay_id} completed as game ${game.id}`);
      else this.lastError=this.store.getJob(job.id).error;
      this.activeJob=null; this.startedAt=null; this.hud=null;
      return game;
    } catch (err) {
      this.fail(err.message);
      if (err instanceof UserError) return null;
      throw err;
    }
  }
  fail(reason) {
    if (this.activeJob) this.store.fail(this.activeJob.id,reason);
    this.lastError=String(reason); this.activeJob=null; this.startedAt=null; this.hud=null;
  }
  async onChat(component) {
    const bot=this.automator, job=this.activeJob;
    // ignore quoted or stale notices
    if (flattenToText(component).trim()!=="Couldn't find a replay by that UUID!"
        || !job || this.seenReplay || !bot?.activeReplay || bot.stopped || bot.broken
        || bot.currentSubmissionId!==job.id) return false;
    if (!this.store.invalidate(job.id)) return false;
    this.lastError="Couldn't find a replay by that UUID!";
    this.activeJob=null; this.startedAt=null; this.hud=null; this.seenReplay=false;
    this.log(`[discord] ${job.replay_id} was not found; moving to the next replay`);
    await bot.skipCurrent();
    return true;
  }
  detach(reason='Minecraft client disconnected. Ask me to retry this replay.') {
    if(this.retryInterrupted&&this.activeJob&&(this.activeJob.disconnect_retries||0)<(this.maxDisconnectRetries??5))this.requeue(reason,true);
    else this.fail(reason);
    this.connection='offline'; this.automator=null;
  }
  requeue(reason,automatic=false) {
    if(this.activeJob)this.store.requeueInterrupted(this.activeJob.id,reason,automatic);
    this.lastError=String(reason);this.activeJob=null;this.startedAt=null;this.hud=null;this.seenReplay=false;
  }
  async tick() {
    const bot=this.automator;
    if (!bot || bot.stopped || bot.broken || !bot.started) return;
    if (this.activeJob) {
      const age=this.now()-this.startedAt;
      const timeout=this.seenReplay ? this.recordingTimeoutMs : this.loadTimeoutMs;
      if (age >= timeout) {
        const reason=this.seenReplay ? 'Recording timed out before finishing.' : 'Replay HUD never loaded. Check that the replay ID is valid and viewable by the recorder account.';
        if(!this.seenReplay && this.store.requeueLoadTimeout(this.activeJob.id,reason,this.maxLoadRetries)){
          this.log(`[discord] ${this.activeJob.replay_id} did not load; returning through the lobby before retrying`);
          this.lastError=reason;this.activeJob=null;this.startedAt=null;this.hud=null;this.seenReplay=false;
        }else this.fail(reason);
        // lobby transitions must not block commands
        void bot.skipCurrent().catch(error=>{
          if(this.automator!==bot || bot.stopped)return;
          this.log(`[discord] Could not leave timed-out replay: ${error.message}`);
          bot.onConnectionError(error);
        });
      }
    } else if (!bot.busy && this.queue.length) bot.resumeIfIdle();
  }
  status() {
    return {connection:this.connection,paused:this.store.paused(),active:this.activeJob,
      hud:this.hud,lastError:this.lastError,broken:Boolean(this.automator?.broken),
      queueSize:this.store.queue().length};
  }
}
