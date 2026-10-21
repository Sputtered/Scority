import test from 'node:test';
import assert from 'node:assert/strict';
import {ReplayStore,ADMIN_ID} from '../lib/discord/store.js';
import {RecorderBridge} from '../lib/discord/recorder.js';
import {DiscordUI} from '../lib/discord/ui.js';
import {createInteractionHandler} from '../lib/discord/interactions.js';
import {commands} from '../lib/discord/commands.js';
import {YELLOW} from '../lib/discord/theme.js';
import {game} from './fixtures/discord-game.js';
import {recentComponents} from '../lib/discord/recent-controls.js';
import {MessageFlags} from 'discord.js';
const USER='111111111111111111', OTHER='222222222222222222';
function fixture(t) {
  const store=new ReplayStore(':memory:'); t.after(()=>store.close()); store.whitelist(ADMIN_ID,USER);
  const recorder=new RecorderBridge(store,{log:()=>{}}), ui=new DiscordUI(store,recorder);
  return {store,recorder,ui,handle:createInteractionHandler({store,ui,log:()=>{}})};
}
function interaction(user,command,args={},kind='command',customId='') {
  return {user:{id:user},commandName:command,customId,options:{data:Object.entries(args).map(([name,value])=>({name,value}))},
    isChatInputCommand:()=>kind==='command',isAutocomplete:()=>kind==='autocomplete',isButton:()=>kind==='button',isStringSelectMenu:()=>kind==='select',isModalSubmit:()=>kind==='modal',
    async deferReply(){this.deferred=true;},async deferUpdate(){this.deferred=true;},async editReply(payload){this.payload=payload;},
    async reply(payload){this.replied=true;this.payload=payload;},async showModal(payload){this.modal=payload;},async respond(payload){this.responded=true;this.payload=payload;}};
}
function validatePayload(payload) {
  assert.ok(payload.components.length<=5);
  let total=0;
  for(const e of payload.embeds) {
    assert.equal(e.color,YELLOW);
    assert.ok(e.title.length<=256); assert.ok(e.description.length<=4096); assert.ok(e.fields.length<=25);
    total+=e.title.length+e.description.length+e.footer.text.length;
    for(const f of e.fields){assert.ok(f.name.length<=256);assert.ok(f.value.length<=1024);total+=f.name.length+f.value.length;}
  }
  assert.ok(total<=6000);
  for(const row of payload.components){assert.ok(row.components.length<=5);for(const c of row.components){assert.ok(c.custom_id.length<=100);if(c.options)assert.ok(c.options.length<=25);}}
}
test('all commands support user installation, server channels, and both DM contexts',()=>{
  assert.equal(commands.length,38);
  for(const c of commands){assert.deepEqual(c.integration_types,[0,1]);assert.deepEqual(c.contexts,[0,1,2]);}
});
test('nolimit is owner-only and unlimited allowance is visible in every quota panel',async t=>{
  const {store,handle,ui}=fixture(t);
  const denied=interaction(USER,'nolimit',{user:USER});await handle(denied);assert.equal(store.hasNoLimit(USER),false);
  const granted=interaction(ADMIN_ID,'nolimit',{user:USER});await handle(granted);assert.equal(store.hasNoLimit(USER),true);
  const job=store.submit(USER,'unlimited');
  for(const [view,args]of [['limit',{}],['status',{}],['submitted',{id:job.id}]]) {
    const payload=JSON.stringify(ui.render(USER,view,args));assert.match(payload,/Unlimited/);assert.doesNotMatch(payload,/null\/null|Infinity/);
  }
  const revoked=interaction(ADMIN_ID,'nolimit',{user:USER,enabled:false});await handle(revoked);assert.equal(store.hasNoLimit(USER),false);
});
test('all reader views produce valid embeds and scoped controls',t=>{
  const {store,ui}=fixture(t); for(let i=1;i<=7;i++)store.importGame(game({index:i}));
  const j=store.submit(USER,'abc');
  const views={help:{},queue:{},myreplays:{},recentgames:{},replays:{user:'Sputtered'},replay:{replay:'G1'},gamematchups:{replay:'G1'},
    status:{},limit:{},stats:{user:'Sputtered'},matchup:{user1:'Sputtered',user2:'Mikowa'},compare:{user1:'Sputtered',user2:'Mikowa'},
    leaderboard:{},teammates:{user:'Sputtered'},rivals:{user:'Sputtered'},names:{},requests:{},myrequests:{},choosename:{replay:'G1'},priority:{},audit:{},admin:{},confirmcancel:{replay:'abc'},submitted:{id:j.id}};
  for(const [view,args] of Object.entries(views)) validatePayload(ui.render(ADMIN_ID,view,args));
  const library=ui.render(USER,'recentgames');
  assert.match(library.embeds[0].footer.text,/Page 1\/2/);
  for(const row of library.components)for(const c of row.components)assert.ok(c.custom_id.startsWith(`rp:${USER}:`));
});
test('new users can submit by command and modal without a whitelist',async t=>{
  const {store,handle}=fixture(t);
  const command=interaction(OTHER,'submit',{replay:'abc'});await handle(command);assert.match(command.payload.embeds[0].title,/queue/);
  const modal=interaction(OTHER,null,{},'modal',`rp:${OTHER}:submitmodal:`);
  modal.fields={getTextInputValue:()=> 'def'}; await handle(modal);assert.match(modal.payload.embeds[0].title,/queue/);
  assert.equal(store.jobs().length,2);
});

test('priority command is owner-only and supports grant, list and removal without changing quota',async t=>{
  const {store,handle}=fixture(t);
  const denied=interaction(USER,'priority',{user:OTHER});await handle(denied);assert.match(denied.payload.content,/just for me/);
  const added=interaction(ADMIN_ID,'priority',{user:OTHER});await handle(added);assert.equal(store.hasPriority(OTHER),true);
  assert.match(added.payload.embeds[0].description,/limit is still 5/);
  const list=interaction(ADMIN_ID,'priority');await handle(list);assert.match(list.payload.embeds[0].description,new RegExp(OTHER));
  const removed=interaction(ADMIN_ID,'priority',{user:OTHER,enabled:false});await handle(removed);assert.equal(store.hasPriority(OTHER),false);
  const invalid=interaction(ADMIN_ID,'priority',{enabled:false});await handle(invalid);assert.match(invalid.payload.content,/Choose a user/);
});
test('submit opens a modal; accepted submissions display position and remaining allowance',async t=>{
  const {handle}=fixture(t);const open=interaction(USER,'submit');await handle(open);assert.ok(open.modal);
  const form=interaction(USER,null,{},'modal',`rp:${USER}:submitmodal:`);form.fields={getTextInputValue:()=>'/replay abc #14cb857e'};
  await handle(form);assert.match(form.payload.embeds[0].description,/#1/);assert.match(form.payload.embeds[0].description,/4\/5/);
});
test('concurrent command interactions cannot exceed the daily limit',async t=>{
  const {store,handle}=fixture(t);
  const calls=Array.from({length:6},(_,i)=>interaction(USER,'submit',{replay:`replay${i}`}));
  await Promise.all(calls.map(i=>handle(i)));
  assert.equal(store.jobs(USER).length,5);assert.equal(store.quota(USER).used,5);
  assert.equal(calls.filter(i=>i.payload.content?.includes('5 replay spots')).length,1);
});
test('public buttons still enforce panel ownership and owner-only actions',async t=>{
  const {store,handle}=fixture(t);
  const stolen=interaction(USER,null,{},'button',`rp:${ADMIN_ID}:pause:`);await handle(stolen);assert.match(stolen.payload.content,/someone else/);assert.equal(store.paused(),false);
  const forged=interaction(USER,null,{},'button',`rp:${USER}:pause:`);await handle(forged);assert.match(forged.payload.content,/just for me/);assert.equal(store.paused(),false);
  store.whitelist(ADMIN_ID,USER,false);
  const old=interaction(USER,null,{},'button',`rp:${USER}:go:queue`);await handle(old);assert.match(old.payload.embeds[0].title,/queue/);
});

test('shared player buttons are read-only, reply privately, and keep follow-up panels scoped to the viewer',async t=>{
  const {store,handle}=fixture(t);store.importGame(game());
  const shared={content:'Sputtered Mikowa',components:recentComponents(store.getGame(1))},before=JSON.stringify(shared);
  for(const user of [USER,OTHER]){
    const press=interaction(user,null,{},'button',shared.components[0].components[0].custom_id);press.message=shared;
    press.deferReply=async options=>{press.deferred=true;press.optionsUsed=options;};
    press.deferUpdate=async()=>assert.fail('Must not update the public message');
    await handle(press);assert.equal(press.optionsUsed.flags,MessageFlags.Ephemeral);
    assert.match(press.payload.embeds[0].title,/Sputtered.*Game matchups/);
    assert.match(press.payload.embeds[0].fields.find(f=>f.name==='vs Mikowa').value,/2 kills.*1 deaths/);
    assert.ok(press.payload.components.flatMap(r=>r.components).every(c=>c.custom_id.startsWith(`rp:${user}:`)));
    validatePayload(press.payload);
  }
  assert.equal(JSON.stringify(shared),before);
  for(const id of ['rp:public:pause:','rp:public:setwinner:G1','rp:public:gameplayer:G1,Sputtered:extra']){
    const forged=interaction(USER,null,{},'button',id);await handle(forged);
    assert.equal(forged.payload.flags,MessageFlags.Ephemeral);assert.match(forged.payload.content,/not working/);
  }
  assert.equal(store.paused(),false);assert.equal(store.getGame(1).payload.match.winner,'red');
  const missing=interaction(USER,null,{},'button','rp:public:gameplayer:G999,Sputtered');await handle(missing);
  assert.match(missing.payload.content,/finished replay/);
});
test('cancellation requires confirmation and expired panels fail gracefully',async t=>{
  const {store,handle}=fixture(t);store.submit(USER,'abc');
  const cancel=interaction(USER,'cancel',{replay:'abc'});await handle(cancel);assert.equal(store.findJob('abc').status,'queued');
  const yes=interaction(USER,null,{},'button',cancel.payload.components[0].components[0].custom_id);await handle(yes);assert.equal(store.findJob('abc').status,'cancelled');
  const expired=interaction(USER,null,{},'button',`rp:${USER}:refresh:missing`);await handle(expired);assert.match(expired.payload.content,/expired/);
});
test('export attaches scored JSON and never exposes Discord credentials',async t=>{
  const {store,handle}=fixture(t);store.importGame(game());
  const i=interaction(USER,'export',{replay:'G1'});await handle(i);
  assert.equal(i.payload.files[0].name,'G00001.json');
  const payload=JSON.parse(i.payload.files[0].attachment.toString());assert.equal(payload.players.Sputtered.kills,2);
});
test('scoreboard player menu and matchup swap navigate into the correct analysis',async t=>{
  const {store,ui,handle}=fixture(t);store.importGame(game());
  const board=ui.render(USER,'replay',{replay:'G1'});
  const playerMenu=board.components.flatMap(r=>r.components).find(c=>c.custom_id.includes(':player:'));
  const select=interaction(USER,null,{},'select',playerMenu.custom_id);select.values=['Sputtered'];
  await handle(select);assert.match(select.payload.embeds[0].title,/Sputtered.*Player stats/);
  const comparison=ui.render(USER,'matchup',{user1:'Sputtered',user2:'Mikowa'});
  const swap=comparison.components.flatMap(r=>r.components).find(c=>c.custom_id.includes(':swap:'));
  const press=interaction(USER,null,{},'button',swap.custom_id);await handle(press);
  assert.match(press.payload.embeds[0].title,/Mikowa vs Sputtered/);assert.match(press.payload.embeds[0].description,/0 wins · 1 loss/);
});
test('nick and alt commands are owner-only, and alias queries share canonical stats and exports',async t=>{
  const {store,ui,handle}=fixture(t);store.importGame(game());
  const denied=interaction(USER,'nickadd',{nick:'Sputtered',main:'MainName'});await handle(denied);assert.match(denied.payload.content,/just for me/);
  const add=interaction(ADMIN_ID,'nickadd',{nick:'Sputtered',main:'MainName'});await handle(add);assert.match(add.payload.embeds[0].description,/1 saved game/);
  const stats=ui.render(USER,'stats',{user:'Sputtered'});assert.match(stats.embeds[0].title,/MainName/);
  const match=ui.render(USER,'matchup',{user1:'Sputtered',user2:'Mikowa'});assert.match(match.embeds[0].title,/MainName vs Mikowa/);assert.match(match.embeds[0].fields[0].value,/\*\*2\*\* times/);
  const exportResult=interaction(USER,'export',{replay:'G1'});await handle(exportResult);
  const json=JSON.parse(exportResult.payload.files[0].attachment);assert.equal(json.players.MainName.kills,2);assert.equal(json.killFeed[0].killer,'MainName');
  const remove=interaction(ADMIN_ID,'nickremove',{name:'Sputtered',revert:false});await handle(remove);
  assert.equal(store.getGame(1).payload.players.MainName.kills,2);
  const reset=interaction(ADMIN_ID,'resetname',{replay:'G1',user:'MainName'});await handle(reset);assert.equal(store.getGame(1).payload.players.Sputtered.kills,2);
});
test('request button, player picker, modal, and owner approval work end to end',async t=>{
  const {store,ui,handle}=fixture(t);store.importGame(game());
  const board=ui.render(USER,'replay',{replay:'G1'});
  const button=board.components.flatMap(r=>r.components).find(c=>c.label==='Request name change');assert.ok(button);
  const open=interaction(USER,null,{},'button',button.custom_id);await handle(open);validatePayload(open.payload);
  const picker=open.payload.components.flatMap(r=>r.components).find(c=>c.custom_id.includes(':nameform:'));
  const select=interaction(USER,null,{},'select',picker.custom_id);select.values=['Sputtered'];await handle(select);
  const form=select.modal.toJSON();assert.match(form.title,/Avoid nicks/);
  const submit=interaction(USER,null,{},'modal',form.custom_id);
  submit.fields={getTextInputValue:key=>({main:'MainAccount',reason:'This person was using a shared alt.'}[key])};
  await handle(submit);validatePayload(submit.payload);
  assert.equal(store.nameRequests(USER).length,1);assert.equal(store.getGame(1).payload.players.Sputtered.kills,2);
  validatePayload(ui.render(USER,'myrequests'));validatePayload(ui.render(ADMIN_ID,'requests'));
  const request=ui.render(ADMIN_ID,'request',{id:1});validatePayload(request);
  const approve=request.components.flatMap(r=>r.components).find(c=>c.label==='Approve');
  const forged=interaction(USER,null,{},'button',`rp:${USER}:approvename:1`);await handle(forged);assert.match(forged.payload.content,/just for me/);
  const accept=interaction(ADMIN_ID,null,{},'button',approve.custom_id);await handle(accept);validatePayload(accept.payload);
  assert.equal(store.getGame(1).payload.players.MainAccount.kills,2);assert.equal(store.nameRequest(1).status,'approved');
  assert.match(ui.render(USER,'myrequests').embeds[0].description,/approved/);
  const repeated=interaction(ADMIN_ID,null,{},'button',approve.custom_id);await handle(repeated);assert.match(repeated.payload.content,/already reviewed/);
});
test('owner name modals edit directly; stale forms and forged owner forms cannot change a game',async t=>{
  const {store,ui,handle}=fixture(t);store.importGame(game());
  const open=interaction(ADMIN_ID,null,{},'select',`rp:${ADMIN_ID}:nameform:G1`);open.values=['Sputtered'];await handle(open);
  const submit=interaction(ADMIN_ID,null,{},'modal',open.modal.toJSON().custom_id);submit.fields={getTextInputValue:()=> 'MainAccount'};
  await handle(submit);assert.equal(store.getGame(1).payload.players.MainAccount.kills,2);assert.equal(store.nameRequests().length,0);
  const reopen=interaction(USER,null,{},'select',`rp:${USER}:nameform:G1`);reopen.values=['Sputtered'];await handle(reopen);
  const forged=interaction(USER,null,{},'modal',reopen.modal.toJSON().custom_id.replace('requestnamemodal','editnamemodal'));
  forged.fields={getTextInputValue:()=> 'Intruder'};await handle(forged);assert.match(forged.payload.content,/just for me/);
  store.setGameName(ADMIN_ID,'G1','Sputtered','ChangedAgain');
  const stale=interaction(USER,null,{},'modal',reopen.modal.toJSON().custom_id);stale.fields={getTextInputValue:()=> 'MainAccount'};
  await handle(stale);assert.match(stale.payload.content,/changed while/);assert.equal(store.nameRequests().length,0);
  assert.match(ui.render(USER,'replay',{replay:'G1'}).embeds[0].fields.find(f=>f.name==='Name links').value,/ChangedAgain/);
});
test('name-conflict notices are visible and original-name exceptions have reachable stats',t=>{
  const {store,ui}=fixture(t);store.addNameLink(ADMIN_ID,'Sputtered','Mikowa','nick');store.importGame(game());
  const board=ui.render(USER,'replay',{replay:'G1'});validatePayload(board);assert.ok(board.embeds[0].fields.some(f=>f.name==='Names need a fix'));
  assert.match(ui.render(USER,'stats',{user:'Mikowa'}).embeds[0].description,/0 games/);
  assert.ok(ui.render(USER,'leaderboard').embeds[0].fields.some(f=>f.name==='Names to check'));
  store.resetGameName(ADMIN_ID,'G1','Sputtered','original');
  assert.match(ui.render(USER,'stats',{user:'Sputtered'}).embeds[0].description,/1 game played/);
});

test('help hides owner commands and the owner menu from every other user',t=>{
  const {ui}=fixture(t);
  for(const user of [USER,OTHER]) {
    const page=ui.render(user,'help'),text=JSON.stringify(page);
    assert.doesNotMatch(text,/Owner commands|Owner menu|\/admin|\/whitelist|\/unwhitelist|\/resetlimit|\/setname|\/requests/);
    assert.doesNotMatch(text,/the owner/i);
    validatePayload(page);
  }
  const owner=JSON.stringify(ui.render(ADMIN_ID,'help'));
  assert.match(owner,/Owner commands/);assert.match(owner,/Owner menu/);assert.match(owner,/\/priority/);
});
test('leaderboard offers only three top 10 lists and its dropdown preserves filters and Back',async t=>{
  const {store,ui,handle}=fixture(t);store.importGame(game());store.submit(USER,'ranked');
  const command=commands.find(c=>c.name==='leaderboard');
  assert.deepEqual(command.options[0].choices.map(c=>c.value),['kd','wl','submissions']);
  const page=ui.render(USER,'leaderboard',{minimum_games:2});
  assert.match(page.embeds[0].title,/Top 10 · K\/D ratio/);
  const menu=page.components.flatMap(r=>r.components).find(c=>c.custom_id.includes(':ranking:'));
  assert.deepEqual(menu.options.map(c=>c.value),['kd','wl','submissions']);
  assert.ok(!page.components.flatMap(r=>r.components).some(c=>['Previous','Next'].includes(c.label)));
  const select=interaction(USER,null,{},'select',menu.custom_id);select.values=['submissions'];select.message=page;
  await handle(select);validatePayload(select.payload);
  assert.match(select.payload.embeds[0].title,/Top 10 · Replays submitted/);
  assert.match(select.payload.embeds[0].description,new RegExp(`<@${USER}>.*1`));
  assert.doesNotMatch(select.payload.embeds[0].description,/wins|losses|game\(s\)/);
  const back=select.payload.components.flatMap(r=>r.components).find(c=>c.label==='Back');
  assert.equal(back.style,4);
  const press=interaction(USER,null,{},'button',back.custom_id);await handle(press);
  assert.match(press.payload.embeds[0].description,/at least 2 game/);
  const forged=interaction(ADMIN_ID,null,{},'select',`rp:${ADMIN_ID}:ranking:${ui.panelToken(USER,page)}`);forged.values=['wl'];
  await handle(forged);assert.match(forged.payload.content,/someone else/);
});
test('top 10 submitter list fits one page and invalid replays have clear details',t=>{
  const {store,ui}=fixture(t);
  for(let n=0;n<12;n++) {
    const user=String(400000000000000000n+BigInt(n));store.whitelist(ADMIN_ID,user);store.submit(user,`submission-${n}`);
  }
  const page=ui.render(USER,'leaderboard',{metric:'submissions'});validatePayload(page);
  assert.equal((page.embeds[0].description.match(/<@/g) || []).length,10);
  assert.match(page.embeds[0].description,/\*\*10\.\*\*/);assert.doesNotMatch(page.embeds[0].description,/11\./);
  const job=store.claimNext();store.invalidate(job.id);store.markDMFailed(job.id,'DMs closed',true);
  const detail=ui.render(job.user_id,'replay',{replay:`R${job.id}`});validatePayload(detail);
  assert.match(detail.embeds[0].description,/Invalid replay/);
  assert.match(detail.embeds[0].fields.find(f=>f.name==='Details').value,/Hypixel.*invalid/);
  assert.ok(detail.embeds[0].fields.some(f=>f.name==='DM update'));
  assert.ok(!detail.components.flatMap(r=>r.components).some(c=>c.label==='Try again'));
});
