import { createHash } from 'node:crypto';
import { escapeMarkdown } from 'discord.js';
import { YELLOW, NICK_REMINDER, resultText } from './theme.js';
import { ADMIN_ID, DAILY_LIMIT, gameLabel, jobLabel, SHORT_REPLAY_REASON, UNKNOWN_LENGTH_REASON } from './store.js';

export function completionMessage(job,game) {
  const winner=game.payload.match.winner;
  return {
    embeds:[{
      color:YELLOW,title:job.rescore_requested_by?'Rescore complete':game.voided?'Your replay was voided':'Your replay is ready! 🟡',
      description:game.voided?`**${escapeMarkdown(job.replay_id)}** was voided and does not count toward stats.\n${escapeMarkdown(game.void_reason)}`:`**${escapeMarkdown(job.replay_id)}** has finished scoring.\n**${resultText(winner)}**\nTap **View results** to see the scores.`,
      fields:[{name:'Replay',value:`${jobLabel(job.job_id)} · ${gameLabel(game.id)}`}],
      footer:{text:`Scority · ${game.winner_reviewed?'Result checked by me':'Result scored by the bot'} · ${NICK_REMINDER}`},
    }],
    components:[{type:1,components:[
      {type:2,style:2,label:'View results',custom_id:`rp:${job.user_id}:detail:${gameLabel(game.id)}`},
      {type:2,style:2,label:'Game matchups',disabled:Boolean(game.voided),custom_id:`rp:${job.user_id}:gamematchups:${gameLabel(game.id)}`},
      {type:2,style:2,label:'My replays',custom_id:`rp:${job.user_id}:go:myreplays`},
    ]}],
    allowedMentions:{parse:[]},
    // stable nonces prevent duplicate retries
    nonce:createHash('sha256').update(`${job.job_id}:${job.replay_id}:${job.user_id}${job.generation?`:${job.generation}`:''}`).digest('hex').slice(0,24),
    enforceNonce:true,
  };
}

export function nameRequestMessage(request) {
  return {
    embeds:[{color:YELLOW,title:`Name change request #${request.id}`,
      description:`**${escapeMarkdown(request.original)} → ${escapeMarkdown(request.main)}**\n${gameLabel(request.game_id)} · requested by <@${request.user_id}>\nApproval changes only this game and its stats.`,
      fields:[{name:'Reason',value:escapeMarkdown(request.reason)}],footer:{text:`Scority · ${NICK_REMINDER}`}}],
    components:[{type:1,components:[
      {type:2,style:2,label:'Approve',custom_id:`rp:${ADMIN_ID}:approvename:${request.id}`},
      {type:2,style:4,label:'Reject',custom_id:`rp:${ADMIN_ID}:rejectname:${request.id}`},
      {type:2,style:2,label:'View game',custom_id:`rp:${ADMIN_ID}:detail:${gameLabel(request.game_id)}`},
    ]}],allowedMentions:{parse:[]},
    nonce:createHash('sha256').update(`name-request:${request.id}:${request.created_at}`).digest('hex').slice(0,24),enforceNonce:true,
  };
}

export function invalidReplayMessage(job,limit=DAILY_LIMIT) {
  const lengthIssue=[SHORT_REPLAY_REASON,UNKNOWN_LENGTH_REASON].includes(job.job_error);
  return {
    embeds:[{color:YELLOW,title:lengthIssue?'Replay not scored':'Replay not found',
      description:lengthIssue?`**${escapeMarkdown(job.replay_id)}** was not scored.\n${job.job_error}\nI removed it from the queue and I’ll move on to the next replay. This still uses one of today’s ${limit} spots.`:`I couldn’t find replay **${escapeMarkdown(job.replay_id)}** on Hypixel.\nI marked it invalid and removed it from the queue. I’ll move on to the next replay.\nCheck the replay ID, then submit a new one. This still uses one of today’s ${limit} spots.`,
      fields:[{name:'Replay',value:jobLabel(job.job_id)}],footer:{text:`Scority · ${NICK_REMINDER}`}}],
    components:[{type:1,components:[
      {type:2,style:2,label:'Submit replay',custom_id:`rp:${job.user_id}:submit:`},
      {type:2,style:2,label:'My replays',custom_id:`rp:${job.user_id}:go:myreplays`},
      {type:2,style:2,label:'Queue',custom_id:`rp:${job.user_id}:go:queue`},
    ]}],allowedMentions:{parse:[]},
    nonce:createHash('sha256').update(`invalid:${job.job_id}:${job.replay_id}:${job.user_id}${job.generation?`:${job.generation}`:''}`).digest('hex').slice(0,24),enforceNonce:true,
  };
}

export function rescoreFailureMessage(job) {
  return {embeds:[{color:YELLOW,title:'Rescore could not finish',
    description:`**${escapeMarkdown(job.replay_id)}** could not be rescored.\n${escapeMarkdown(job.job_error || 'Recording failed.')}\nYour saved game and its previous results are still available. No daily submission was charged.`,
    fields:[{name:'Replay',value:`${jobLabel(job.job_id)} · ${gameLabel(job.game_id)}`}]}],
    components:[{type:1,components:[{type:2,style:2,label:'View saved results',custom_id:`rp:${job.user_id}:detail:${gameLabel(job.game_id)}`}]}],
    allowedMentions:{parse:[]},enforceNonce:true,
    nonce:createHash('sha256').update(`rescore-failed:${job.job_id}:${job.generation}`).digest('hex').slice(0,24)};
}

export class CompletionNotifier {
  constructor({store,send,cards=null,log=console.error}) { this.store=store;this.send=send;this.cards=cards;this.log=log;this.inFlight=null;this.timer=null;this.stopped=false; }
  tick() {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight=this.deliver().catch(err=>this.log(`[discord] Completion DM failed: ${err.message}`)).finally(()=>{this.inFlight=null;});
    return this.inFlight;
  }
  async deliver() {
    const job=this.store.nextCompletionDM();
    if (!job) return;
    if (!this.store.allowed(job.user_id)) {
      this.store.markDMFailed(job.job_id,'Invalid Discord user ID',true,job.generation);return;
    }
    try {
      let payload;
      if (job.rescore_requested_by && ['invalid','failed'].includes(job.job_status)) payload=rescoreFailureMessage(job);
      else if (job.job_status==='invalid') payload=invalidReplayMessage(job,this.store.runtimeSetting('submissions.dailyLimit',DAILY_LIMIT));
      else {
        const game=this.store.getGame(job.game_id);
        const message=completionMessage(job,game);
        payload=this.cards?await this.cards.decorate(message,{kind:'game',game,user:job.user_id}):message;
      }
      await this.send(job.user_id,payload);
      this.store.markDMSent(job.job_id,job.generation);
    } catch (err) {
      // permanent delivery failures
      const permanent=[50007,50001,50013,10013].includes(Number(err.code));
      this.store.markDMFailed(job.job_id,err.message,permanent,job.generation);
      this.log(`[discord] Could not DM ${jobLabel(job.job_id)}: ${err.message}`);
    }
  }
  start() {
    if (this.timer) return;
    this.stopped=false;
    this.timer=setInterval(()=>{void this.tick();},1000);
  }
  async stop() { this.stopped=true;clearInterval(this.timer);this.timer=null;await this.inFlight; }
}

export class NameRequestNotifier extends CompletionNotifier {
  async deliver() {
    const request=this.store.nextNameRequestDM(); if (!request) return;
    try {
      await this.send(ADMIN_ID,nameRequestMessage(request));
      this.store.markNameRequestDM(request.id);
    } catch (err) {
      this.store.markNameRequestDM(request.id,err.message,[50007,50001,50013,10013].includes(Number(err.code)));
      this.log(`[discord] Could not DM name request ${request.id}: ${err.message}`);
    }
  }
}
