import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

test('two managed accounts record independently through real sockets and one account reconnects',{timeout:15000},async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('./fixtures/discord-proxy-pool.js',import.meta.url))],{timeout:12000,maxBuffer:1024*1024});
  assert.match(stdout,/DISCORD_PROXY_POOL_OK/);
});

test('managed auth failures and shutdown release headless timers before a socket exists',{timeout:15000},async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('./fixtures/discord-proxy-auth-failure.js',import.meta.url))],{timeout:12000,maxBuffer:1024*1024});
  assert.match(stdout,/DISCORD_PROXY_AUTH_CLEANUP_OK/);
});
test('managed recorder rejoins after a kick and scores the interrupted job exactly once', {timeout:15000}, async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('./fixtures/discord-proxy-e2e.js',import.meta.url)),'managed-kick'],{timeout:12000,maxBuffer:1024*1024});
  assert.match(stdout,/DISCORD_PROXY_E2E_OK/);
});
test('actual proxy records a Discord job over local Minecraft sockets without website calls', {timeout:15000}, async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('./fixtures/discord-proxy-e2e.js',import.meta.url))],{timeout:10000,maxBuffer:1024*1024});
  assert.match(stdout,/DISCORD_PROXY_E2E_OK/);
});
test('actual proxy skips a missing replay reported in server chat and scores the next job', {timeout:15000}, async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('./fixtures/discord-proxy-e2e.js',import.meta.url)),'invalid-first'],{timeout:10000,maxBuffer:1024*1024});
  assert.match(stdout,/DISCORD_PROXY_E2E_OK/);
});

test('actual proxy skips 179-second replays and scores a 180-second replay without leaking kills', {timeout:15000}, async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('./fixtures/discord-proxy-e2e.js',import.meta.url)),'short-first'],{timeout:10000,maxBuffer:1024*1024});
  assert.match(stdout,/DISCORD_PROXY_E2E_OK/);
});
