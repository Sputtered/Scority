import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import mc from 'minecraft-protocol';
import { relayPlayPacket } from '../lib/relay.js';

test('relay isolates connection state, keepalive IDs, and compression', () => {
  const writes=[];
  const source={state:'play'};
  const target={state:'play',write:(...args)=>writes.push(args)};
  for (const name of ['keep_alive','set_compression']) {
    assert.equal(relayPlayPacket(source,target,{}, {name,state:'play'}),false);
  }
  assert.equal(relayPlayPacket(source,target,{}, {name:'success',state:'login'}),false);
  target.state='login';
  assert.equal(relayPlayPacket(source,target,{}, {name:'chat',state:'play'}),false);
  target.state='play';
  assert.equal(relayPlayPacket(source,target,{message:'hi'}, {name:'chat',state:'play'}),true);
  assert.deepEqual(writes,[['chat',{message:'hi'}]]);
});

test('1.8.9 raw relay round-trips gameplay across different compression settings', {timeout:10000}, async t => {
  const servers=[]; const clients=[]; const errors=[];
  t.after(() => {
    for (const s of servers) s.close();
    for (const c of clients) c.socket?.destroy();
  });
  async function pair(threshold, username) {
    const server=mc.createServer({'online-mode':false,host:'127.0.0.1',port:0,version:'1.8.9',keepAlive:false});
    servers.push(server); server.on('error',e=>errors.push(e));
    await once(server,'listening');
    const accepted=once(server,'login');
    const client=mc.createClient({host:'127.0.0.1',port:server.socketServer.address().port,
      version:'1.8.9',username,auth:'offline',keepAlive:false});
    clients.push(client); client.on('error',e=>errors.push(e));
    const joined=once(client,'playerJoin');
    const [peer]=await accepted; clients.push(peer); peer.on('error',e=>errors.push(e));
    await joined;
    peer.write('set_compression',{threshold}); peer.compressionThreshold=threshold;
    return {client,peer};
  }
  const upstream=await pair(1,'Upstream');
  const downstream=await pair(256,'Downstream');
  upstream.client.on('packet',(data,meta,buffer)=>relayPlayPacket(upstream.client,downstream.peer,data,meta,buffer));
  downstream.peer.on('packet',(data,meta,buffer)=>relayPlayPacket(downstream.peer,upstream.client,data,meta,buffer));
  const received=once(downstream.client,'chat');
  const payload={message:JSON.stringify({text:'Alice was killed by Bob.'}),position:0};
  upstream.peer.write('chat',payload);
  assert.deepEqual((await received)[0],payload);
  const reply=once(upstream.peer,'chat');
  downstream.client.write('chat',{message:'/replay fixture'});
  assert.deepEqual((await reply)[0],{message:'/replay fixture'});
  assert.deepEqual(errors,[]);
});
