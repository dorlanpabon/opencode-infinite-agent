const assert = require('node:assert/strict');
const test = require('node:test');
const { abortRemoteSession } = require('../src/agent');

test('detach del modo continuo nunca llama /abort remoto', async () => {
  const calls = [];
  const req = async (...args) => { calls.push(args); return true; };
  assert.equal(abortRemoteSession(req, { id: 'ses_exact' }, { abortRemoteOnSignal: false }), false);
  await Promise.resolve();
  assert.equal(calls.length, 0);

  assert.equal(abortRemoteSession(req, { id: 'ses_exact' }, { abortRemoteOnSignal: true }), true);
  await Promise.resolve();
  assert.deepEqual(calls[0].slice(0, 3), ['POST', '/session/ses_exact/abort', {}]);
});
