import http from 'node:http';
import {randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {ADMIN_ID,UserError,gameLabel} from '../discord/store.js';
import {ImageCards} from '../discord/cards/service.js';
import {playerStats,playerNames} from '../discord/stats.js';
import {ControlStore} from '../control-store.js';

const publicDir=new URL('./public/',import.meta.url),assets=new URL('../../assets/',import.meta.url);
const staticFiles=new Map([
  ['/',['index.html','text/html; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/style.css',['style.css','text/css; charset=utf-8']],
]);
staticFiles.set('/controls.js',['controls.js','text/javascript; charset=utf-8']);
staticFiles.set('/controls.css',['controls.css','text/css; charset=utf-8']);
for(const name of ['diamond','barrier','emerald','diamond_sword','iron_sword','bone','skull','arrow','bed','stonebrick','obsidian'])staticFiles.set(`/assets/${name}.png`,[`minecraft/${name}.png`,'image/png',true]);
staticFiles.set('/assets/logo.webp',['branding/scority-logo.webp','image/webp',true]);
staticFiles.set('/assets/Lato-Regular.ttf',['fonts/Lato-Regular.ttf','font/ttf',true]);
staticFiles.set('/assets/Lato-Bold.ttf',['fonts/Lato-Bold.ttf','font/ttf',true]);
const digest=value=>scryptSync(value,'scority-admin-v1',32);
class HttpError extends Error{constructor(status,message){super(message);this.status=status;}}
async function body(req){
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw new HttpError(415,'Send JSON.');
  let length=0;const chunks=[];
  for await(const chunk of req){length+=chunk.length;if(length>1024*1024)throw new HttpError(413,'The edit is too large.');chunks.push(chunk);}
  try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}catch{throw new HttpError(400,'Send a JSON object.');}
}
function summary(game){return {id:game.id,label:gameLabel(game.id),replayId:game.replay_id,date:game.recorded_at,winner:game.payload.match.winner,
  duration:game.payload.match.totalDurationSec,players:Object.keys(game.payload.players),voided:game.voided,conflict:game.payload.nameLinks?.excludedFromStats};}

export async function startAdminServer({store,key,host='127.0.0.1',port=3080,origin,trustProxy=false,cards=new ImageCards({store}),now=()=>Date.now(),log=console.error}={}){
  if(typeof key!=='string'||!key)throw new Error('SCORITY_WEB_KEY is required.');
  if(origin && !(new URL(origin).protocol==='https:' || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)))throw new Error('Public admin access requires HTTPS.');
  let allowedOrigin=origin?.replace(/\/$/,'');const keyHash=digest(key),sessions=new Map(),attempts=new Map();
  const control=new ControlStore(store);
  const csrf=()=>randomBytes(24).toString('hex');
  function send(res,status,value,type='application/json; charset=utf-8'){
    res.writeHead(status,{'Content-Type':type});res.end(Buffer.isBuffer(value)?value:type.startsWith('application/json')?JSON.stringify(value):value);
  }
  function failLogin(ip){
    for(const name of [ip,'*']){const value=attempts.get(name);attempts.set(name,{count:(value?.until>now()?value.count:0)+1,until:value?.until>now()?value.until:now()+15*60_000});}
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try{
      const url=new URL(req.url,'http://local'),route=url.pathname,method=req.method;
      if(req.headers.host!==new URL(allowedOrigin).host)throw new HttpError(403,'Invalid host.');
      const ip=trustProxy && ['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)?String(req.headers['x-real-ip']||req.socket.remoteAddress):req.socket.remoteAddress;
      for(const [id,s]of sessions)if(s.expires<=now())sessions.delete(id);
      for(const [id,s]of attempts)if(s.until<=now())attempts.delete(id);
      const token=/(?:^|;\s*)scority_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1],session=sessions.get(token);
      const cookie=(token,age)=>`scority_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${allowedOrigin.startsWith('https:')?'; Secure':''}`;
      if(!['GET','HEAD','POST','PUT'].includes(method))throw new HttpError(405,'Method not allowed.');
      if(method==='POST'||method==='PUT'){
        if(req.headers.origin!==allowedOrigin)throw new HttpError(403,'Invalid request origin.');
        if(route!=='/api/login' && (!session||req.headers['x-csrf-token']!==session.csrf))throw new HttpError(403,'Refresh the page and sign in again.');
      }
      if(route==='/api/login' && method==='POST'){
        if((attempts.get(ip)?.count||0)>=8 || (attempts.get('*')?.count||0)>=60 || attempts.size>=1000){res.setHeader('Retry-After','900');throw new HttpError(429,'Too many login attempts. Try again in 15 minutes.');}
        const input=await body(req);failLogin(ip);
        if(typeof input?.key!=='string'||input.key.length>1024||!timingSafeEqual(digest(input.key),keyHash))throw new HttpError(401,'Incorrect access key.');
        if(token)sessions.delete(token);if(sessions.size>=128)sessions.delete(sessions.keys().next().value);
        const id=randomBytes(32).toString('hex'),entry={csrf:csrf(),expires:now()+8*3600_000};sessions.set(id,entry);attempts.delete(ip);
        res.setHeader('Set-Cookie',cookie(id,8*3600));return send(res,200,{authenticated:true,csrf:entry.csrf});
      }
      if(route==='/api/session' && method==='GET')return send(res,200,{authenticated:Boolean(session),csrf:session?.csrf});
      if(route==='/api/logout' && method==='POST'){sessions.delete(token);res.setHeader('Set-Cookie',cookie('',0));return send(res,200,{ok:true});}
      if(staticFiles.has(route) && ['GET','HEAD'].includes(method)){
        const [file,type,isAsset]=staticFiles.get(route);const buffer=await readFile(new URL(file,isAsset?assets:publicDir));return send(res,200,method==='HEAD'?Buffer.alloc(0):buffer,type);
      }
      if(!session)throw new HttpError(401,'Sign in to continue.');
      if(route==='/api/control'&&method==='GET')return send(res,200,{runtime:control.status(),settings:control.settings(),events:control.events()});
      if(route==='/api/settings'&&method==='PUT'){
        const input=await body(req);if(!input.values||typeof input.values!=='object'||Array.isArray(input.values))throw new HttpError(400,'Send setting values.');
        return send(res,200,control.save(ADMIN_ID,input.version,input.values));
      }
      if(route==='/api/control/commands'&&method==='POST'){const input=await body(req);return send(res,202,control.enqueue(ADMIN_ID,input.action,{workerId:input.workerId}));}
      const commandRoute=/^\/api\/control\/commands\/(\d+)$/.exec(route);
      if(commandRoute&&method==='GET'){const command=control.command(Number(commandRoute[1]));if(!command)throw new HttpError(404,'Action not found.');return send(res,200,command);}
      if(route==='/api/jobs'&&method==='GET')return send(res,200,{jobs:store.jobs().slice(0,200)});
      if(route==='/api/jobs'&&method==='POST'){
        const input=await body(req);let job;
        if(input.action==='submit')job=store.submit(ADMIN_ID,input.replayId);
        else if(input.action==='cancel')job=store.cancel(ADMIN_ID,`R${Number(input.id)}`);
        else if(input.action==='retry')job=store.retry(ADMIN_ID,`R${Number(input.id)}`);
        else throw new HttpError(400,'Choose submit, cancel, or retry.');
        return send(res,200,{job});
      }
      if(route==='/api/access'&&method==='GET'){
        const ids=new Set([...store.priorityMembers().map(r=>r.user_id),...store.db.prepare('SELECT user_id FROM unlimited_users').all().map(r=>r.user_id),...store.jobs().map(r=>r.user_id)]);
        return send(res,200,{users:[...ids].map(id=>({id,priority:store.hasPriority(id),unlimited:store.hasNoLimit(id),quota:store.quota(id)}))});
      }
      if(route==='/api/access'&&method==='POST'){
        const input=await body(req);
        if(['priority','unlimited'].includes(input.action)&&typeof input.enabled!=='boolean')throw new HttpError(400,'Choose enabled or disabled.');
        if(input.action==='priority')store.setPriority(ADMIN_ID,input.id,input.enabled);
        else if(input.action==='unlimited')store.setNoLimit(ADMIN_ID,input.id,input.enabled);
        else if(input.action==='reset-limit')store.resetLimit(ADMIN_ID,input.id);
        else throw new HttpError(400,'Unknown user action.');return send(res,200,{ok:true});
      }
      if(route==='/api/names'&&method==='GET')return send(res,200,{links:store.nameLinks(),requests:store.nameRequests().filter(r=>r.status==='pending')});
      if(route==='/api/names'&&method==='POST'){
        const input=await body(req);
        if(input.action==='link')store.addNameLink(ADMIN_ID,input.alias,input.main,input.kind);
        else if(input.action==='unlink')store.removeNameLink(ADMIN_ID,input.alias,input.kind,true);
        else if(['approve','reject'].includes(input.action))store.reviewNameRequest(ADMIN_ID,Number(input.id),input.action==='approve');
        else throw new HttpError(400,'Unknown name action.');return send(res,200,{ok:true});
      }
      if(route==='/api/audit'&&method==='GET')return send(res,200,{entries:store.audit()});
      if(route==='/api/games' && method==='GET'){
        const q=(url.searchParams.get('q')||'').trim().toLowerCase(),filter=url.searchParams.get('filter')||'all';
        const all=store.games(),filtered=all.filter(g=>{
          const s=summary(g);return (!q||[s.label,s.replayId,...s.players,...g.payload.nameLinks.assignments.map(n=>n.original)].some(v=>String(v||'').toLowerCase().includes(q))) &&
            (filter==='all'||filter==='voided'&&s.voided||filter==='review'&&s.conflict||filter===s.winner&&!s.voided);
        });
        const pages=Math.max(1,Math.ceil(filtered.length/12)),page=Math.min(pages,Math.max(1,Number(url.searchParams.get('page'))||1));
        return send(res,200,{games:filtered.slice((page-1)*12,page*12).map(summary),page,pages,total:filtered.length,
          stats:{games:all.length,players:playerNames(all).length,queued:store.queue().length,paused:store.paused()}});
      }
      if(route==='/api/queue' && method==='GET')return send(res,200,{paused:store.paused(),jobs:store.queue().map(j=>({id:j.id,replayId:j.replay_id,status:j.status,priority:Boolean(j.priority),rescore:Boolean(j.rescore_requested_by)}))});
      if(route==='/api/queue' && method==='POST'){const input=await body(req);if(typeof input?.paused!=='boolean')throw new HttpError(400,'Choose pause or resume.');store.pause(ADMIN_ID,input.paused);return send(res,200,{paused:store.paused()});}
      if(route==='/api/players' && method==='GET'){
        const games=store.games(),q=(url.searchParams.get('q')||'').toLowerCase();
        const rows=playerNames(games).filter(n=>n.toLowerCase().includes(q)).map(n=>{const {history,...stats}=playerStats(games,n);return stats;});
        return send(res,200,{players:rows.sort((a,b)=>b.games-a.games || b.kills-a.kills)});
      }
      const match=/^\/api\/games\/(\d+)(?:\/(card\.png|export|rescore|restore))?$/.exec(route);
      if(match){
        const id=Number(match[1]),action=match[2],game=store.getGame(id);if(!game)throw new HttpError(404,'Game not found.');
        if(!action && method==='GET')return send(res,200,{...store.gameEditor(id),rescore:store.rescoreJob(id)||null});
        if(!action && method==='PUT'){const input=await body(req);return send(res,200,store.saveGameEditor(ADMIN_ID,id,input.version,input.draft));}
        if(action==='restore'&&method==='POST'){const input=await body(req);return send(res,200,store.restoreGameEditor(ADMIN_ID,id,input.version,input.historyId));}
        if(action==='rescore'&&method==='POST'){await body(req);const job=store.rescore(ADMIN_ID,gameLabel(id));return send(res,200,{id:job.id,status:job.status});}
        if(action==='export'&&method==='GET'){res.setHeader('Content-Disposition',`attachment; filename="scority-${gameLabel(id)}.json"`);return send(res,200,game.payload);}
        if(action==='card.png'&&method==='GET'){
          if(game.payload.nameLinks?.excludedFromStats)throw new HttpError(409,'Fix conflicting player names to display this card.');
          return send(res,200,await cards.image('game',game,'inventory'),'image/png');
        }
      }
      throw new HttpError(404,'Not found.');
    }catch(error){
      if(res.headersSent){res.destroy();return;}
      const status=error.status || (error instanceof UserError?409:500);
      if(status===500)log(`[web] ${error.message}`);
      send(res,status,{error:status===500?'Something went wrong. Try again.':error.message});
    }
  });
  server.requestTimeout=20000;server.headersTimeout=15000;server.keepAliveTimeout=5000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  allowedOrigin ||= `http://${host}:${server.address().port}`;
  return {server,origin:allowedOrigin,close:()=>new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();})};
}
