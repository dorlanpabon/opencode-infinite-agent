const assert = require('node:assert/strict');
const test = require('node:test');
const { parseSessionRef, resolveSession } = require('../src/session');

const sessionId = 'ses_fc8392c3bffeYWSYR8wU6WTiY6';
const internalLink = `oc://renderer/server/c2lkZWNhcg/session/${sessionId}`;

test('parseSessionRef acepta solo un ID exacto o el enlace interno sidecar exacto', () => {
  assert.equal(parseSessionRef(sessionId), sessionId);
  assert.equal(parseSessionRef(internalLink), sessionId);
  assert.equal(parseSessionRef(null), null);
  assert.equal(parseSessionRef(''), null);

  for (const invalid of [
    `prefix-${sessionId}`,
    `oc://evil/server/c2lkZWNhcg/session/${sessionId}`,
    `oc://renderer/server/otro/session/${sessionId}`,
    `oc://renderer/server/c2lkZWNhcg%2Fotro/session/${sessionId}`,
    `${internalLink}?directory=C%3A%5Csecreto`,
    `${internalLink}/message`,
  ]) {
    assert.equal(parseSessionRef(invalid), null, invalid);
  }
});

test('resolveSession usa solo el segmento final validado y rechaza referencias ambiguas antes del request', async () => {
  const calls = [];
  const req = async (...args) => {
    calls.push(args);
    return { id: sessionId };
  };

  const resolved = await resolveSession(req, { ref: internalLink, title: null });
  assert.deepEqual(resolved, { session: { id: sessionId }, created: false });
  assert.deepEqual(calls, [['GET', `/session/${sessionId}`]]);

  for (const invalid of [`x/${sessionId}`, `${internalLink}?token=secret`, `${internalLink}/extra`]) {
    await assert.rejects(resolveSession(req, { ref: invalid, title: null }), /referencia.*no es válida/iu);
  }
  assert.equal(calls.length, 1);
});
