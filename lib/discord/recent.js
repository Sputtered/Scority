import {createHash} from 'node:crypto';
import {CompletionNotifier} from './notifications.js';
import {gameLabel} from './store.js';
import {gameCardFingerprint} from './cards/snapshot.js';
import {recentComponents} from './recent-controls.js';

export const recentContent=game=>Object.keys(game.payload.players).join(' ');

// reconcile uncertain sends before retrying
export class RecentPublisher extends CompletionNotifier {
  constructor({store,cards,channelId,send,edit,findSent,refreshInterval=10_000,log=console.error}) {
    super({store,cards,send,log});
    if(!/^\d{17,20}$/.test(channelId))throw new Error('Invalid recent-games channel ID');
    this.channelId=channelId;this.findSent=findSent;this.edit=edit;
    this.refreshInterval=refreshInterval;this.nextRefreshScan=0;
    store.db.exec(`CREATE TABLE IF NOT EXISTS recent_posts (
      channel_id TEXT NOT NULL,game_id INTEGER NOT NULL REFERENCES games(id),
      status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,
      first_attempt_at TEXT,next_at TEXT NOT NULL,message_id TEXT,error TEXT,
      PRIMARY KEY(channel_id,game_id));`);
    if(!store.db.prepare('PRAGMA table_info(recent_posts)').all().some(c=>c.name==='snapshot_hash'))
      store.db.exec('ALTER TABLE recent_posts ADD COLUMN snapshot_hash TEXT');
    if(!store.db.prepare('PRAGMA table_info(recent_posts)').all().some(c=>c.name==='content_text'))
      store.db.exec('ALTER TABLE recent_posts ADD COLUMN content_text TEXT');
    if(!store.db.prepare('PRAGMA table_info(recent_posts)').all().some(c=>c.name==='components_json'))
      store.db.exec('ALTER TABLE recent_posts ADD COLUMN components_json TEXT');
  }
  fingerprint(game) {return gameCardFingerprint(game,this.cards.gameStyle==='off'?'inventory':this.cards.gameStyle);}
  async deliver() {
    const db=this.store.db,now=this.store.now().toISOString();
    db.prepare(`INSERT OR IGNORE INTO recent_posts(channel_id,game_id,next_at)
      SELECT ?,id,? FROM games`).run(this.channelId,now);
    const post=db.prepare(`SELECT p.* FROM recent_posts p JOIN games g ON g.id=p.game_id
      WHERE p.channel_id=? AND p.status!='sent' ORDER BY g.recorded_at,g.id LIMIT 1`).get(this.channelId);
    if(!post || post.next_at>now)return this.refresh();
    try {
      if(post.status==='sending') {
        if(!this.findSent)throw new Error('Cannot safely retry without channel-history reconciliation');
        const found=await this.findSent(post);
        if(found){this.sent(post,found);return;}
      }
      const game=this.store.getGame(post.game_id);
      const hash=this.fingerprint(game),content=recentContent(game);
      const components=recentComponents(game);
      const file=await this.cards.gameAttachment(game);
      db.prepare(`UPDATE recent_posts SET status='sending',first_attempt_at=COALESCE(first_attempt_at,?),
        attempts=attempts+1,snapshot_hash=?,content_text=?,components_json=? WHERE channel_id=? AND game_id=?`).run(now,hash,content,JSON.stringify(components),this.channelId,post.game_id);
      const message=await this.send(this.channelId,{content,components,files:[file],allowedMentions:{parse:[]},
        nonce:createHash('sha256').update(`recent:${this.channelId}:${post.game_id}`).digest('hex').slice(0,24),enforceNonce:true});
      this.sent(post,message.id);
    } catch(error) {
      const delay=Math.min(3600_000,15_000*2**Math.min(post.attempts,8));
      db.prepare('UPDATE recent_posts SET next_at=?,error=? WHERE channel_id=? AND game_id=?')
        .run(new Date(this.store.now().getTime()+delay).toISOString(),String(error.message).slice(0,1000),this.channelId,post.game_id);
      this.log(`[discord] Recent ${gameLabel(post.game_id)} waiting to retry: ${error.message}`);
    }
  }
  sent(post,id) {
    this.store.db.prepare("UPDATE recent_posts SET status='sent',message_id=?,attempts=0,error=NULL WHERE channel_id=? AND game_id=?")
      .run(id,this.channelId,post.game_id);
  }
  async refresh() {
    const now=this.store.now();
    if(!this.edit || now.getTime()<this.nextRefreshScan)return;
    const db=this.store.db;
    // missing hashes refresh legacy cards
    const posts=db.prepare("SELECT * FROM recent_posts WHERE channel_id=? AND status='sent' AND next_at<=? ORDER BY game_id DESC")
      .all(this.channelId,now.toISOString());
    for(const post of posts) {
      const game=this.store.getGame(post.game_id),hash=this.fingerprint(game),content=recentContent(game);
      const components=recentComponents(game),componentsJSON=JSON.stringify(components);
      if(hash===post.snapshot_hash && content===post.content_text && componentsJSON===post.components_json)continue;
      try {
        const payload={content,components,allowedMentions:{parse:[]}};
        if(hash!==post.snapshot_hash)Object.assign(payload,{attachments:[],files:[await this.cards.gameAttachment(game)]});
        await this.edit(this.channelId,post,payload);
        // concurrent edits need another pass
        db.prepare('UPDATE recent_posts SET snapshot_hash=?,content_text=?,components_json=?,attempts=0,error=NULL,next_at=? WHERE channel_id=? AND game_id=?')
          .run(hash,content,componentsJSON,this.store.now().toISOString(),this.channelId,post.game_id);
      } catch(error) {
        const delay=Math.min(3600_000,15_000*2**Math.min(post.attempts,8));
        db.prepare('UPDATE recent_posts SET attempts=attempts+1,next_at=?,error=? WHERE channel_id=? AND game_id=?')
          .run(new Date(this.store.now().getTime()+delay).toISOString(),String(error.message).slice(0,1000),this.channelId,post.game_id);
        this.log(`[discord] Recent ${gameLabel(post.game_id)} refresh waiting to retry: ${error.message}`);
      }
      return;
    }
    this.nextRefreshScan=now.getTime()+this.refreshInterval;
  }
}

export async function editRecentMessage(channel,post,botId,payload) {
  const message=await channel.messages.fetch(post.message_id);
  if(message.author.id!==botId || ![...message.attachments.values()].some(a=>a.name===`game-${gameLabel(post.game_id)}.png`))
    throw new Error('Recent message does not match this bot and game');
  return message.edit(payload);
}

export async function findRecentMessage(channel,post,botId) {
  const filename=`game-${gameLabel(post.game_id)}.png`;
  const since=Date.parse(post.first_attempt_at)-5000;
  if(!Number.isFinite(since))throw new Error('Missing posting timestamp');
  let before;
  for(;;) {
    const page=await channel.messages.fetch({limit:100,...(before?{before}:{})});
    if(!page.size)return null;
    const messages=[...page.values()];
    const match=messages.find(m=>m.author.id===botId && [...m.attachments.values()].some(a=>a.name===filename));
    if(match)return match.id;
    const oldest=messages.reduce((a,b)=>BigInt(a.id)<BigInt(b.id)?a:b);
    if(oldest.createdTimestamp<since || page.size<100)return null;
    before=oldest.id;
  }
}
