import {applyAssists} from '../assists.js';
import {teamKnown} from '../team-colors.js';
import { normalizeReplayId } from '../replay-id.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { nameKey, projectNames, recordedNames } from './identities.js';
import {initGameEdits,statEdits,applyGameEdits,gameEditor,saveGameEditor,restoreGameEditor} from './game-edits.js';

export const ADMIN_ID = (process.env.DISCORD_OWNER_ID || '').trim();
export const DAILY_LIMIT = 5;
export const MIN_REPLAY_SECONDS = 180;
export const SHORT_REPLAY_REASON = 'Replays must be at least 180 seconds (3 minutes) long.';
export const UNKNOWN_LENGTH_REASON = 'I couldn’t check this replay’s length. Replays must be at least 180 seconds (3 minutes) long.';
export function replayLengthIssue(seconds) {
  return !Number.isFinite(seconds) || seconds<=0 ? UNKNOWN_LENGTH_REASON : seconds<MIN_REPLAY_SECONDS ? SHORT_REPLAY_REASON : null;
}
export const TIME_ZONE = 'America/Los_Angeles';
export class UserError extends Error {}
export const jobLabel = id => `R${String(id).padStart(5, '0')}`;
export const gameLabel = id => `G${String(id).padStart(5, '0')}`;
export function dayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {timeZone: TIME_ZONE, year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
}
export function nextReset(date = new Date()) {
  const day = dayKey(date);
  let low = date.getTime(), high = low + 26 * 3600_000;
  while (high - low > 1000) {
    const mid = Math.floor((low + high) / 2);
    if (dayKey(new Date(mid)) === day) low = mid; else high = mid;
  }
  return Math.floor(high / 1000);
}
export function replayId(input) {
  const id = normalizeReplayId(input);
  if (!id) throw new UserError('Enter a replay ID or `/replay <id>` · one replay at a time.');
  return id;
}
export function ign(input) {
  const name = String(input || '').trim();
  if (!/^[a-zA-Z0-9_]{1,16}$/.test(name)) throw new UserError('Enter a Minecraft name (1–16 letters, numbers, or underscores).');
  return name;
}
function discordId(input) {
  const id = String(input || '').trim().replace(/^<@!?(\d+)>$/, '$1');
  if (!/^\d{17,20}$/.test(id)) throw new UserError('Enter a Discord user ID (Developer Mode → Copy User ID).');
  return id;
}

export class ReplayStore {
  constructor(filename, { now = () => new Date() } = {}) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), {recursive:true});
    this.now = now;
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS whitelist (user_id TEXT PRIMARY KEY, added_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS priority_users (user_id TEXT PRIMARY KEY, added_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS unlimited_users (user_id TEXT PRIMARY KEY, added_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage (user_id TEXT, day TEXT, count INTEGER NOT NULL, PRIMARY KEY(user_id,day));
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS games (id INTEGER PRIMARY KEY, replay_id TEXT COLLATE NOCASE UNIQUE,
        fingerprint TEXT UNIQUE NOT NULL, recorded_at TEXT NOT NULL, payload TEXT NOT NULL,
        winner_reviewed INTEGER NOT NULL DEFAULT 0, winner_override TEXT, review_reason TEXT);
      CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, replay_id TEXT COLLATE NOCASE NOT NULL UNIQUE,
        user_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', submitted_at TEXT NOT NULL,
        queued_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, game_id INTEGER REFERENCES games(id));
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL,
        detail TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS completion_dms (job_id INTEGER PRIMARY KEY REFERENCES jobs(id),
        status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        next_at TEXT NOT NULL, sent_at TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS name_links (alias TEXT PRIMARY KEY COLLATE NOCASE, main TEXT NOT NULL COLLATE NOCASE,
        kind TEXT NOT NULL CHECK(kind IN ('nick','alt')), created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS game_names (game_id INTEGER REFERENCES games(id), original TEXT COLLATE NOCASE,
        main TEXT NOT NULL, PRIMARY KEY(game_id,original));
      CREATE TABLE IF NOT EXISTS name_requests (id INTEGER PRIMARY KEY, game_id INTEGER NOT NULL REFERENCES games(id),
        user_id TEXT NOT NULL, original TEXT NOT NULL COLLATE NOCASE, main TEXT NOT NULL, reason TEXT NOT NULL,
        expected_state TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, reviewed_at TEXT,
        dm_status TEXT NOT NULL DEFAULT 'pending', dm_attempts INTEGER NOT NULL DEFAULT 0,
        dm_next_at TEXT NOT NULL, dm_error TEXT);
      CREATE TABLE IF NOT EXISTS game_voids (game_id INTEGER PRIMARY KEY REFERENCES games(id),
        reason TEXT NOT NULL, actor TEXT NOT NULL, voided_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS game_revisions (id INTEGER PRIMARY KEY, game_id INTEGER NOT NULL REFERENCES games(id),
        job_id INTEGER NOT NULL REFERENCES jobs(id), actor TEXT NOT NULL, replaced_at TEXT NOT NULL,
        fingerprint TEXT NOT NULL, payload TEXT NOT NULL);`);
    this.transaction(()=>{
      for(const [table,column,definition]of [
        ['jobs','submission_credit','INTEGER NOT NULL DEFAULT 1'],
        ['jobs','rescore_requested_by','TEXT'],
        ['jobs','disconnect_retries','INTEGER NOT NULL DEFAULT 0'],
        ['jobs','load_retries','INTEGER NOT NULL DEFAULT 0'],
        ['jobs','worker_id',"TEXT NOT NULL DEFAULT 'default'"],
        ['completion_dms','generation','INTEGER NOT NULL DEFAULT 0'],
      ])if(!this.db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name===column))
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      this.db.exec(`DROP INDEX IF EXISTS one_recording;
        CREATE UNIQUE INDEX IF NOT EXISTS one_recording_per_worker ON jobs(worker_id) WHERE status='recording';`);
    });
    initGameEdits(this.db);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }
  log(actor, action, detail) {
    this.db.prepare('INSERT INTO audit(actor,action,detail,created_at) VALUES(?,?,?,?)')
      .run(actor,action,JSON.stringify(detail),this.now().toISOString());
  }
  isAdmin(id) { return Boolean(ADMIN_ID) && id === ADMIN_ID; }
  allowed(id) { return /^\d{17,20}$/.test(String(id)); }
  requireAccess(id) { if (!this.allowed(id)) throw new UserError('A valid Discord account is required.'); }
  requireAdmin(id) { if (!this.isAdmin(id)) throw new UserError('This control is just for me.'); }
  whitelist(actor, target, add = true) {
    this.requireAdmin(actor); target = discordId(target);
    if (!add && target === ADMIN_ID) throw new UserError('I always have access.');
    return this.transaction(() => {
      if (add) this.db.prepare('INSERT OR IGNORE INTO whitelist VALUES(?,?)').run(target,this.now().toISOString());
      else {
        this.db.prepare('DELETE FROM whitelist WHERE user_id=?').run(target);
      }
      this.log(actor,add?'whitelist':'unwhitelist',{target}); return target;
    });
  }
  members() { return this.db.prepare('SELECT * FROM whitelist ORDER BY added_at DESC').all(); }
  priorityMembers() { return this.db.prepare('SELECT * FROM priority_users ORDER BY added_at,user_id').all(); }
  hasPriority(id) { return Boolean(this.db.prepare('SELECT 1 FROM priority_users WHERE user_id=?').get(id)); }
  setPriority(actor,target,enabled=true) {
    this.requireAdmin(actor); target=discordId(target);
    if(typeof enabled!=='boolean')throw new UserError('Choose whether priority is enabled.');
    return this.transaction(()=>{
      if(enabled)this.db.prepare('INSERT OR IGNORE INTO priority_users VALUES(?,?)').run(target,this.now().toISOString());
      else this.db.prepare('DELETE FROM priority_users WHERE user_id=?').run(target);
      this.log(actor,'priority',{target,enabled});return target;
    });
  }
  quota(id) {
    const used = this.db.prepare('SELECT count FROM usage WHERE user_id=? AND day=?').get(id,dayKey(this.now()))?.count || 0;
    if(this.hasNoLimit(id))return {used,remaining:null,limit:null,unlimited:true,reset:nextReset(this.now())};
    const limit=this.runtimeSetting('submissions.dailyLimit',DAILY_LIMIT);
    return {used,remaining:Math.max(0,limit-used),limit,reset:nextReset(this.now())};
  }
  runtimeSetting(key,fallback){const row=this.db.prepare("SELECT value FROM settings WHERE key='bot_settings'").get();return row?(JSON.parse(row.value)[key]??fallback):fallback;}
  hasNoLimit(id) { return Boolean(this.db.prepare('SELECT 1 FROM unlimited_users WHERE user_id=?').get(id)); }
  setNoLimit(actor,target,enabled=true) {
    this.requireAdmin(actor); target=discordId(target);
    if(typeof enabled!=='boolean')throw new UserError('Choose whether unlimited submissions are enabled.');
    return this.transaction(()=>{
      if(enabled)this.db.prepare('INSERT OR IGNORE INTO unlimited_users VALUES(?,?)').run(target,this.now().toISOString());
      else this.db.prepare('DELETE FROM unlimited_users WHERE user_id=?').run(target);
      this.log(actor,'nolimit',{target,enabled});return target;
    });
  }
  resetLimit(actor, target) {
    this.requireAdmin(actor); target = discordId(target);
    this.transaction(() => {
      this.db.prepare('DELETE FROM usage WHERE user_id=? AND day=?').run(target,dayKey(this.now()));
      this.log(actor,'resetlimit',{target});
    }); return target;
  }
  submit(user, input) {
    this.requireAccess(user); const id = replayId(input);
    if(!this.runtimeSetting('submissions.enabled',true))throw new UserError('Replay submissions are temporarily disabled.');
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM jobs WHERE replay_id=?').get(id);
      if (existing) throw new UserError(`That replay is already saved as ${jobLabel(existing.id)}. Use /replay to check it.`);
      if (this.db.prepare('SELECT id FROM games WHERE replay_id=?').get(id)) throw new UserError('That replay is already scored. Use /replay to see it.');
      const quota=this.quota(user);
      if (!quota.unlimited && !quota.remaining) throw new UserError(`You have used today's ${quota.limit} replay spots. Your limit resets <t:${nextReset(this.now())}:R> (midnight Pacific).`);
      const time = this.now().toISOString();
      const result = this.db.prepare('INSERT INTO jobs(replay_id,user_id,submitted_at,queued_at) VALUES(?,?,?,?)').run(id,user,time,time);
      this.db.prepare('INSERT INTO usage VALUES(?,?,1) ON CONFLICT(user_id,day) DO UPDATE SET count=count+1').run(user,dayKey(this.now()));
      this.log(user,'submit',{replayId:id});
      return this.getJob(Number(result.lastInsertRowid));
    });
  }
  getJob(id) { return this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id); }
  findJob(ref) {
    const key = String(ref || '');
    return /^R\d+$/i.test(key) ? this.getJob(Number(key.slice(1))) : this.db.prepare('SELECT * FROM jobs WHERE replay_id=?').get(key);
  }
  jobs(user = null) {
    return user ? this.db.prepare('SELECT * FROM jobs WHERE user_id=? ORDER BY id DESC').all(user)
      : this.db.prepare('SELECT * FROM jobs ORDER BY id DESC').all();
  }
  submissionLeaderboard() {
    return this.db.prepare(`SELECT user_id, COUNT(*) AS submissions FROM jobs j
      WHERE submission_credit=1 AND (status<>'invalid' OR game_id IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM game_voids v WHERE v.game_id=j.game_id)
      GROUP BY user_id ORDER BY submissions DESC,user_id LIMIT 10`).all();
  }
  queue() { return this.db.prepare(`SELECT j.*, (p.user_id IS NOT NULL) AS priority FROM jobs j
    LEFT JOIN priority_users p ON p.user_id=j.user_id WHERE j.status IN ('queued','recording')
    ORDER BY CASE j.status WHEN 'recording' THEN 0 ELSE 1 END,priority DESC,j.queued_at,j.id`).all(); }
  position(id) { const i = this.queue().findIndex(j=>j.id===id); return i < 0 ? null : i+1; }
  paused() { return this.db.prepare("SELECT value FROM settings WHERE key='paused'").get()?.value === 'true'; }
  pause(actor, paused) {
    this.requireAdmin(actor);
    this.transaction(() => {
      this.db.prepare("INSERT INTO settings VALUES('paused',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(paused));
      this.log(actor,paused?'pause':'resume',{});
    });
  }
  claimNext(workerId='default') {
    if(typeof workerId!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(workerId))throw new Error('Invalid recorder worker ID.');
    return this.transaction(() => {
      if (this.paused() || this.db.prepare("SELECT id FROM jobs WHERE status='recording' AND worker_id=?").get(workerId)) return null;
      const job = this.queue().find(j=>j.status==='queued');
      if (!job) return null;
      this.db.prepare("UPDATE jobs SET status='recording',worker_id=?,started_at=?,error=NULL,attempts=attempts+1 WHERE id=?").run(workerId,this.now().toISOString(),job.id);
      return this.getJob(job.id);
    });
  }
  recover() {
    return this.db.prepare("UPDATE jobs SET status='queued', started_at=NULL, error='Recorder restarted; queued again' WHERE status='recording'").run().changes;
  }
  requeueInterrupted(id,reason,automatic=false){
    return this.db.prepare("UPDATE jobs SET status='queued',started_at=NULL,finished_at=NULL,error=?,disconnect_retries=disconnect_retries+? WHERE id=? AND status='recording'").run(String(reason).slice(0,500),automatic?1:0,id).changes;
  }
  requeueLoadTimeout(id,reason,maxRetries){
    return this.db.prepare("UPDATE jobs SET status='queued',started_at=NULL,finished_at=NULL,error=?,load_retries=load_retries+1 WHERE id=? AND status='recording' AND load_retries<?")
      .run(String(reason).slice(0,500),id,maxRetries).changes;
  }
  fail(id, reason) {
    return this.transaction(()=>{
      const result=this.db.prepare("UPDATE jobs SET status='failed',finished_at=?,error=? WHERE id=? AND status='recording'")
        .run(this.now().toISOString(),String(reason).slice(0,500),id);
      if(result.changes && this.getJob(id).rescore_requested_by)this._queueCompletionDM(id);
    });
  }
  invalidate(id,reason="Couldn't find a replay by that UUID!") {
    return this.transaction(() => this._invalidate(id,reason));
  }
  _invalidate(id,reason) {
    const result=this.db.prepare("UPDATE jobs SET status='invalid',finished_at=?,error=? WHERE id=? AND status='recording'")
      .run(this.now().toISOString(),String(reason).slice(0,500),id);
    if (!result.changes) return false;
    this._queueCompletionDM(id);
    return true;
  }
  cancel(actor, ref) {
    this.requireAccess(actor);
    return this.transaction(() => {
      const job = this.findJob(ref);
      if (!job || (job.user_id !== actor && !this.isAdmin(actor))) throw new UserError('You can only cancel your own waiting replays.');
      if (job.status !== 'queued') throw new UserError('You can only cancel a replay that is still waiting.');
      this.db.prepare("UPDATE jobs SET status='cancelled',finished_at=? WHERE id=?").run(this.now().toISOString(),job.id);
      this.log(actor,'cancel',{id:job.id}); return this.getJob(job.id);
    });
  }
  retry(actor, ref) {
    this.requireAdmin(actor);
    return this.transaction(() => {
      const job = this.findJob(ref);
      if (!job || !['failed','cancelled'].includes(job.status)) throw new UserError('Choose a replay that failed or was cancelled.');
      this.db.prepare("UPDATE jobs SET status='queued',queued_at=?,error=NULL,finished_at=NULL,disconnect_retries=0,load_retries=0 WHERE id=?").run(this.now().toISOString(),job.id);
      if(job.rescore_requested_by)this.db.prepare("UPDATE completion_dms SET status='superseded' WHERE job_id=? AND status='pending'").run(job.id);
      this.log(actor,'retry',{id:job.id}); return this.getJob(job.id);
    });
  }
  rescoreJob(gameId) {
    return this.db.prepare('SELECT * FROM jobs WHERE game_id=? AND rescore_requested_by IS NOT NULL ORDER BY queued_at DESC,id DESC LIMIT 1').get(gameId);
  }
  rescore(actor,ref) {
    this.requireAdmin(actor);
    return this.transaction(()=>{
      const game=this.findGame(ref);
      if(!game)throw new UserError('Choose a saved game to rescore.');
      if(!game.replay_id)throw new UserError('This saved game has no replay ID to load again.');
      const rid=replayId(game.replay_id);
      if(this.db.prepare("SELECT 1 FROM jobs WHERE (game_id=? OR replay_id=?) AND status IN ('queued','recording')").get(game.id,rid))
        throw new UserError('This game is already queued or being recorded.');
      let job=this.findJob(rid);const time=this.now().toISOString();
      if(job){
        if(job.game_id && job.game_id!==game.id)throw new UserError('This replay is linked to another game. Existing results kept.');
        this.db.prepare("UPDATE jobs SET status='queued',game_id=?,rescore_requested_by=?,queued_at=?,started_at=NULL,finished_at=NULL,error=NULL,disconnect_retries=0,load_retries=0 WHERE id=?")
          .run(game.id,actor,time,job.id);
        this.db.prepare("UPDATE completion_dms SET status='superseded' WHERE job_id=? AND status='pending'").run(job.id);
      }else{
        const inserted=this.db.prepare('INSERT INTO jobs(replay_id,user_id,submitted_at,queued_at,game_id,submission_credit,rescore_requested_by) VALUES(?,?,?,?,?,0,?)')
          .run(rid,actor,time,time,game.id,actor);
        job=this.getJob(Number(inserted.lastInsertRowid));
      }
      this.log(actor,'rescore',{id:game.id,job:job.id,replayId:rid});return this.getJob(job.id);
    });
  }
  _fingerprint(payload) {
    if (!payload?.match || !payload.players || !Array.isArray(payload.killFeed) || !Array.isArray(payload.bedBreaks)
        || Object.keys(payload.players).length === 0 || payload.killFeed.length === 0) {
      throw new UserError('We found no game to score in this replay.');
    }
    const lengthIssue=replayLengthIssue(payload.match.totalDurationSec);
    if (lengthIssue) throw new UserError(lengthIssue);
    return createHash('sha256').update(JSON.stringify({
      duration:payload.match.totalDurationSec,
      kills:payload.killFeed.map(e=>[e.t,e.victim,e.killer,Boolean(e.finalKill)]),
      beds:payload.bedBreaks.map(e=>[e.t,e.team,e.breaker]),
    })).digest('hex');
  }
  _import(payload, forcedReplayId = null) {
    const fingerprint=this._fingerprint(payload);
    const rid = forcedReplayId || payload.match.replayId || null;
    const existing = (rid && this.db.prepare('SELECT id FROM games WHERE replay_id=?').get(rid))
      || this.db.prepare('SELECT id FROM games WHERE fingerprint=?').get(fingerprint);
    if (existing) {
      if (rid) this.db.prepare('UPDATE games SET replay_id=COALESCE(replay_id,?) WHERE id=?').run(rid,existing.id);
      return existing.id;
    }
    const time = payload.match.capturedAt || payload.match.generatedAt;
    const recordedAt = time && Number.isFinite(Date.parse(time)) ? new Date(time).toISOString() : this.now().toISOString();
    return Number(this.db.prepare('INSERT INTO games(replay_id,fingerprint,recorded_at,payload) VALUES(?,?,?,?)')
      .run(rid,fingerprint,recordedAt,JSON.stringify(payload)).lastInsertRowid);
  }
  importGame(payload) { return this.transaction(()=>this._import(payload)); }
  _replaceScore(job,payload) {
    const fingerprint=this._fingerprint(payload);
    if(payload.match.endReason!=='replay_finished' || payload.tracking?.status==='invalid')
      throw new UserError('The new recording was incomplete. Existing results kept.');
    if(payload.match.replayId && replayId(payload.match.replayId)!==replayId(job.replay_id))
      throw new UserError('The recording belongs to a different replay. Existing results kept.');
    const previous=this.db.prepare('SELECT * FROM games WHERE id=?').get(job.game_id);
    if(!previous)throw new UserError('The original game was not found.');
    if(this.db.prepare('SELECT 1 FROM games WHERE fingerprint=? AND id<>?').get(fingerprint,previous.id))
      throw new UserError('The new recording matches another saved game. Existing results kept.');
    const names=new Set(recordedNames(payload).map(nameKey));
    if(Object.keys(statEdits(this,previous.id).players || {}).some(n=>!Object.hasOwn(payload.players,n)))
      throw new UserError('The new recording is missing a player with saved stat edits. Existing results kept.');
    if(this.gameNames(previous.id).some(n=>!names.has(nameKey(n.original))))
      throw new UserError('The new recording is missing a player with a saved name correction. Existing results kept.');
    this.db.prepare('INSERT INTO game_revisions(game_id,job_id,actor,replaced_at,fingerprint,payload) VALUES(?,?,?,?,?,?)')
      .run(previous.id,job.id,job.rescore_requested_by,this.now().toISOString(),previous.fingerprint,previous.payload);
    const updated={...payload,match:{...payload.match,replayId:job.replay_id}};
    this.db.prepare('UPDATE games SET fingerprint=?,payload=? WHERE id=?').run(fingerprint,JSON.stringify(updated),previous.id);
    this.log(job.rescore_requested_by,'rescored',{id:previous.id,job:job.id});return previous.id;
  }
  complete(id, payload) {
    return this.transaction(() => {
      const job = this.getJob(id);
      if (!job || job.status !== 'recording') throw new UserError('This replay is no longer being scored.');
      const lengthIssue=replayLengthIssue(payload?.match?.totalDurationSec);
      if (lengthIssue) { this._invalidate(id,lengthIssue); return null; }
      const gameId = job.rescore_requested_by ? this._replaceScore(job,payload) : this._import(payload,job.replay_id);
      this.db.prepare("UPDATE jobs SET status='completed',finished_at=?,game_id=?,error=NULL WHERE id=?").run(this.now().toISOString(),gameId,id);
      this._queueCompletionDM(id);
      return this.getGame(gameId);
    });
  }
  _queueCompletionDM(id) {
    this.db.prepare(`INSERT INTO completion_dms(job_id,next_at) VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET
      status='pending',attempts=0,next_at=excluded.next_at,sent_at=NULL,error=NULL,generation=generation+1`).run(id,this.now().toISOString());
  }
  nextCompletionDM() {
    return this.db.prepare(`SELECT d.*, COALESCE(j.rescore_requested_by,j.user_id) AS user_id, j.rescore_requested_by,
      j.replay_id, j.game_id, j.status AS job_status, j.error AS job_error FROM completion_dms d
      JOIN jobs j ON j.id=d.job_id WHERE d.status='pending' AND d.next_at<=?
        AND (j.status IN ('completed','invalid') OR (j.status='failed' AND j.rescore_requested_by IS NOT NULL))
      ORDER BY d.next_at,d.job_id LIMIT 1`).get(this.now().toISOString());
  }
  completionDM(id) { return this.db.prepare('SELECT * FROM completion_dms WHERE job_id=?').get(id); }
  markDMSent(id,generation=this.completionDM(id)?.generation) {
    this.db.prepare("UPDATE completion_dms SET status='sent',sent_at=?,attempts=attempts+1,error=NULL WHERE job_id=? AND status='pending' AND generation=?")
      .run(this.now().toISOString(),id,generation??-1);
  }
  markDMFailed(id, reason, permanent=false,generation=this.completionDM(id)?.generation) {
    const dm=this.completionDM(id);
    if (!dm || dm.status!=='pending' || dm.generation!==generation) return;
    const attempts=dm.attempts+1;
    const next=new Date(this.now().getTime()+attempts*30_000).toISOString();
    this.db.prepare("UPDATE completion_dms SET status=?,attempts=?,next_at=?,error=? WHERE job_id=? AND status='pending' AND generation=?")
      .run(permanent || attempts>=3?'failed':'pending',attempts,next,String(reason).slice(0,500),id,generation);
  }
  decodeGame(row, links = this.nameLinks(), overrides = null) {
    if (!row) return null;
    const payload = applyGameEdits(JSON.parse(row.payload),statEdits(this,row.id));
    if (row.winner_reviewed) {
      payload.match.winner = row.winner_override;
      payload.match.winReason = 'admin_review';
    }
    applyAssists(payload);
    projectNames(payload,links,overrides || this.gameNames(row.id));
    const voidInfo=this.db.prepare('SELECT * FROM game_voids WHERE game_id=?').get(row.id);
    payload.match.voided=Boolean(voidInfo);
    if (voidInfo) payload.match.voidReason=voidInfo.reason;
    else delete payload.match.voidReason;
    return {...row,voided:Boolean(voidInfo),void_reason:voidInfo?.reason || null,payload};
  }
  setVoided(actor,ref,voided,reason='') {
    this.requireAdmin(actor);
    return this.transaction(() => {
      const game=this.findGame(ref);
      if (!game) throw new UserError('Choose a finished game to void or restore.');
      if (game.voided===voided) throw new UserError(voided?'This game is already voided.':'This game is not voided.');
      const note=String(reason).trim().slice(0,200) || 'Voided by me.';
      if (voided) this.db.prepare('INSERT INTO game_voids VALUES(?,?,?,?)').run(game.id,note,actor,this.now().toISOString());
      else this.db.prepare('DELETE FROM game_voids WHERE game_id=?').run(game.id);
      this.log(actor,voided?'void':'unvoid',{id:game.id,...(voided?{reason:note}:{})});
      return this.getGame(game.id);
    });
  }
  getGame(id) { return this.decodeGame(this.db.prepare('SELECT * FROM games WHERE id=?').get(id)); }
  gameEditor(id) { return gameEditor(this,id); }
  saveGameEditor(actor,id,version,draft) { return saveGameEditor(this,actor,id,version,draft); }
  restoreGameEditor(actor,id,version,history) { return restoreGameEditor(this,actor,id,version,history); }
  findGame(ref) {
    const key = String(ref || '');
    if (/^G\d+$/i.test(key)) return this.getGame(Number(key.slice(1)));
    const job = this.findJob(key);
    if (job?.game_id) return this.getGame(job.game_id);
    return this.decodeGame(this.db.prepare('SELECT * FROM games WHERE replay_id=?').get(key));
  }
  games() {
    const links=this.nameLinks(), overrides=new Map();
    for (const entry of this.db.prepare('SELECT * FROM game_names').all()) {
      const rows=overrides.get(entry.game_id) || []; rows.push(entry); overrides.set(entry.game_id,rows);
    }
    return this.db.prepare('SELECT * FROM games ORDER BY recorded_at DESC,id DESC').all().map(r=>this.decodeGame(r,links,overrides.get(r.id) || []));
  }
  nameLinks() { return this.db.prepare('SELECT * FROM name_links ORDER BY alias COLLATE NOCASE').all(); }
  gameNames(id) { return this.db.prepare('SELECT * FROM game_names WHERE game_id=?').all(id); }
  resolvePlayer(input) {
    const name=ign(input);
    return this.db.prepare('SELECT main FROM name_links WHERE alias=?').get(name)?.main || name;
  }
  lookupPlayer(input) {
    const name=ign(input);
    // keep original-name profiles reachable
    for (const game of this.games()) {
      if (game.payload.nameLinks.excludedFromStats) continue;
      const found=Object.keys(game.payload.players).find(player=>nameKey(player)===nameKey(name));
      if (found) return found;
    }
    return this.resolvePlayer(name);
  }
  nameState(game) { return JSON.stringify(game.payload.nameLinks.assignments); }
  originalName(game, input) {
    const name=ign(input), entries=game.payload.nameLinks.assignments;
    const raw=entries.find(e=>nameKey(e.original)===nameKey(name));
    if (raw) return raw.original;
    const matches=entries.filter(e=>nameKey(e.main)===nameKey(name));
    if (matches.length===1) return matches[0].original;
    throw new UserError('Choose a name recorded in this game. Use the name change button to see the original names.');
  }
  assertNoNewNameConflicts(before, after) {
    const signatures=game=>game.payload.nameLinks.conflicts.map(c=>JSON.stringify([nameKey(c.main),c.names.map(nameKey).sort()]));
    const old=new Map(before.map(game=>[game.id,new Set(signatures(game))]));
    const conflicts=after.filter(game=>signatures(game).some(value=>!old.get(game.id)?.has(value)));
    if (conflicts.length) throw new UserError(`This would count two players as one in ${conflicts.slice(0,5).map(g=>gameLabel(g.id)).join(', ')}. No changes saved. Use /setname to fix the names for those games first.`);
  }
  addNameLink(actor, alias, main, kind) {
    this.requireAdmin(actor); alias=ign(alias); main=ign(main);
    if (!['nick','alt'].includes(kind)) throw new UserError('Choose a nick or an alt.');
    // single-step links prevent cycles
    if (nameKey(alias)===nameKey(main)) throw new UserError('The nick or alt must be different from the main name.');
    main=this.resolvePlayer(main);
    if (nameKey(alias)===nameKey(main)) throw new UserError('That name already leads back to this account.');
    if (this.db.prepare('SELECT 1 FROM name_links WHERE main=?').get(alias)) {
      throw new UserError('That name is already a main account for other links. Remove or move those links first using /names.');
    }
    return this.transaction(()=>{
      const before=this.games();
      this.db.prepare('INSERT INTO name_links VALUES(?,?,?,?) ON CONFLICT(alias) DO UPDATE SET main=excluded.main,kind=excluded.kind')
        .run(alias,main,kind,this.now().toISOString());
      const after=this.games(); this.assertNoNewNameConflicts(before,after);
      const count=after.filter(g=>g.payload.nameLinks.assignments.some(e=>nameKey(e.link)===nameKey(alias))).length;
      this.log(actor,'namelink',{alias,main,kind,games:count}); return {alias,main,kind,count};
    });
  }
  removeNameLink(actor, alias, kind, revert=true) {
    this.requireAdmin(actor); alias=ign(alias);
    return this.transaction(()=>{
      const link=this.db.prepare('SELECT * FROM name_links WHERE alias=? AND kind=?').get(alias,kind);
      if (!link) throw new UserError(`That ${kind} has no saved link. Check /names.`);
      const before=this.games(); let count=0;
      for (const game of before) {
        const entries=game.payload.nameLinks.assignments.filter(e=>nameKey(e.link)===nameKey(alias));
        if (!entries.length) continue;
        count++;
        if (!revert) for (const entry of entries) this.db.prepare('INSERT INTO game_names VALUES(?,?,?) ON CONFLICT(game_id,original) DO UPDATE SET main=excluded.main')
          .run(game.id,entry.original,entry.main);
      }
      this.db.prepare('DELETE FROM name_links WHERE alias=?').run(alias);
      this.assertNoNewNameConflicts(before,this.games());
      this.log(actor,'nameunlink',{alias,main:link.main,kind,revert,games:count}); return {alias:link.alias,count,revert};
    });
  }
  _setGameName(game, original, main) {
    this.db.prepare('INSERT INTO game_names VALUES(?,?,?) ON CONFLICT(game_id,original) DO UPDATE SET main=excluded.main')
      .run(game.id,original,main);
    const updated=this.getGame(game.id);
    this.assertNoNewNameConflicts([game],[updated]); return updated;
  }
  setGameName(actor, ref, input, target) {
    this.requireAdmin(actor);
    return this.transaction(()=>{
      const game=this.findGame(ref); if (!game) throw new UserError('Choose a finished replay.');
      const original=this.originalName(game,input), name=ign(target);
      const main=nameKey(name)===nameKey(original)?original:this.resolvePlayer(name);
      const updated=this._setGameName(game,original,main);
      this.log(actor,'gamename',{id:game.id,original,main}); return updated;
    });
  }
  resetGameName(actor, ref, input, mode='original') {
    this.requireAdmin(actor);
    if (!['original','follow'].includes(mode)) throw new UserError('Choose original name or follow name links.');
    return this.transaction(()=>{
      const game=this.findGame(ref); if (!game) throw new UserError('Choose a finished replay.');
      const original=this.originalName(game,input);
      if (mode==='original') this._setGameName(game,original,original);
      else this.db.prepare('DELETE FROM game_names WHERE game_id=? AND original=?').run(game.id,original);
      const updated=this.getGame(game.id); this.assertNoNewNameConflicts([game],[updated]);
      this.log(actor,'resetname',{id:game.id,original,mode}); return updated;
    });
  }
  nameRequests(user=null) {
    return user ? this.db.prepare('SELECT * FROM name_requests WHERE user_id=? ORDER BY id DESC').all(user)
      : this.db.prepare('SELECT * FROM name_requests ORDER BY id DESC').all();
  }
  nameRequest(id) { return this.db.prepare('SELECT * FROM name_requests WHERE id=?').get(id); }
  requestNameChange(user, ref, input, target, reason, expectedState=null) {
    this.requireAccess(user);
    return this.transaction(()=>{
      const game=this.findGame(ref); if (!game) throw new UserError('Choose a finished replay.');
      const original=this.originalName(game,input), name=ign(target);
      const main=nameKey(name)===nameKey(original)?original:this.resolvePlayer(name);
      const state=this.nameState(game);
      if (expectedState && state!==expectedState) throw new UserError('The names changed while this form was open. Open the game and try again.');
      const current=game.payload.nameLinks.assignments.find(e=>e.original===original).main;
      if (nameKey(current)===nameKey(main)) throw new UserError('That player already uses this name in this game.');
      const text=String(reason || '').trim().slice(0,200);
      if (!text) throw new UserError('Tell me why this name should change.');
      if (this.db.prepare("SELECT 1 FROM name_requests WHERE game_id=? AND original=? AND status='pending'").get(game.id,original)) {
        throw new UserError('This player already has a request waiting for this game. I’ll review it soon.');
      }
      if (this.nameRequests(user).filter(r=>r.status==='pending').length>=5) throw new UserError('You already have 5 requests waiting. Let me review those first.');
      const proposed=this.decodeGame(this.db.prepare('SELECT * FROM games WHERE id=?').get(game.id),this.nameLinks(),
        [...this.gameNames(game.id).filter(e=>nameKey(e.original)!==nameKey(original)),{original,main}]);
      this.assertNoNewNameConflicts([game],[proposed]);
      const time=this.now().toISOString();
      const id=Number(this.db.prepare('INSERT INTO name_requests(game_id,user_id,original,main,reason,expected_state,created_at,dm_next_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(game.id,user,original,main,text,state,time,time).lastInsertRowid);
      this.log(user,'namerequest',{id:game.id,request:id,original,main}); return this.nameRequest(id);
    });
  }
  reviewNameRequest(actor, id, approve) {
    this.requireAdmin(actor);
    return this.transaction(()=>{
      const request=this.nameRequest(id);
      if (!request || request.status!=='pending') throw new UserError('This request was already reviewed or could not be found.');
      if (approve) {
        const game=this.getGame(request.game_id);
        if (this.nameState(game)!==request.expected_state ||
            (nameKey(request.main)!==nameKey(request.original) && nameKey(this.resolvePlayer(request.main))!==nameKey(request.main))) {
          throw new UserError('These names changed after the request was sent. Reject this request and use /setname if a change is still needed.');
        }
        this._setGameName(game,request.original,request.main);
      }
      this.db.prepare("UPDATE name_requests SET status=?,reviewed_at=?,dm_status=CASE WHEN dm_status='pending' THEN 'skipped' ELSE dm_status END WHERE id=?")
        .run(approve?'approved':'rejected',this.now().toISOString(),id);
      this.log(actor,approve?'nameapprove':'namereject',{id:request.game_id,request:id,original:request.original,main:request.main});
      return this.nameRequest(id);
    });
  }
  nextNameRequestDM() {
    return this.db.prepare("SELECT * FROM name_requests WHERE status='pending' AND dm_status='pending' AND dm_next_at<=? ORDER BY dm_next_at,id LIMIT 1").get(this.now().toISOString());
  }
  markNameRequestDM(id, error=null, permanent=false) {
    const request=this.nameRequest(id); if (!request || request.dm_status!=='pending') return;
    const attempts=request.dm_attempts+1;
    this.db.prepare('UPDATE name_requests SET dm_status=?,dm_attempts=?,dm_next_at=?,dm_error=? WHERE id=?')
      .run(!error?'sent':permanent || attempts>=3?'failed':'pending',attempts,
        new Date(this.now().getTime()+attempts*30_000).toISOString(),error?String(error).slice(0,500):null,id);
  }
  setWinner(actor, ref, team, reason) {
    this.requireAdmin(actor);
    if (!teamKnown(team) && team!=='unknown') throw new UserError('Choose a supported team or unknown.');
    const game = this.findGame(ref);
    if (!game) throw new UserError('That finished replay was not found.');
    this.transaction(() => {
      this.db.prepare('UPDATE games SET winner_reviewed=1,winner_override=?,review_reason=? WHERE id=?')
        .run(team==='unknown'?null:team,String(reason || 'Reviewed by me').slice(0,200),game.id);
      this.log(actor,'setwinner',{id:game.id,team,reason});
    });
    return this.getGame(game.id);
  }
  audit() { return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 100').all(); }
}
