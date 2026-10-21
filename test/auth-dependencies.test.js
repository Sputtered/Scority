import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('patched UUID retains Microsoft auth GUID generation', () => {
  const { CryptoProvider } = require('@azure/msal-node');
  assert.match(new CryptoProvider().createNewGuid(), uuidPattern);
});
test('patched UUID retains Yggdrasil client tokens without a network request', async t => {
  const utils = require('yggdrasil/src/utils');
  t.mock.method(utils, 'call', async (_host, _endpoint, body) => body);
  const result = await require('yggdrasil')().auth({user:'fixture',pass:'fixture'});
  assert.match(result.clientToken, uuidPattern);
});
