import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('a fresh installation grants owner access only to its configured account', () => {
  const code = `
    import assert from 'node:assert/strict';
    import {ReplayStore} from './lib/discord/store.js';
    const store = new ReplayStore(':memory:');
    assert.equal(store.isAdmin('888888888888888888'), Boolean(process.env.DISCORD_OWNER_ID));
    assert.equal(store.isAdmin('335458050905341952'), false);
    assert.equal(store.isAdmin(''), false);
    store.close();
  `;
  for (const owner of ['', '888888888888888888']) {
    execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: new URL('../', import.meta.url),
      env: {...process.env, DISCORD_OWNER_ID: owner},
      stdio: 'pipe',
    });
  }
});

test('multiple-account setup supplies the settings default without a single-account username', () => {
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import config from './config.js';
    assert.equal(config.mojangUsername, 'first@example.invalid');
  `], {
    cwd: new URL('../', import.meta.url),
    env: {...process.env, MINECRAFT_USERNAME: '', MINECRAFT_ACCOUNTS: ' first@example.invalid,second@example.invalid'},
    stdio: 'pipe',
  });
});
