const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  OPENCODE_DESKTOP_SERVER_KEY,
  buildOpenCodeInternalSessionLink,
  buildOpenCodeProjectUrl,
} = require('../dist/desktop/session-links.js');

test('construye únicamente el protocolo público para abrir un workspace absoluto', () => {
  const workspace = path.resolve('workspace con espacios');
  const link = buildOpenCodeProjectUrl(workspace);
  const url = new URL(link);
  assert.equal(url.protocol, 'opencode:');
  assert.equal(url.host, 'open-project');
  assert.equal(url.searchParams.get('directory'), workspace);
  assert.deepEqual([...url.searchParams.keys()], ['directory']);
  assert.equal(url.hash, '');
  assert.throws(() => buildOpenCodeProjectUrl('workspace-relativo'), /absoluta/iu);
  assert.throws(() => buildOpenCodeProjectUrl(` ${workspace}`), /absoluta/iu);
});

test('construye el enlace interno solo desde un ID de sesión estricto y serverKey fijo', () => {
  assert.equal(OPENCODE_DESKTOP_SERVER_KEY, 'c2lkZWNhcg');
  assert.equal(
    buildOpenCodeInternalSessionLink('ses_fc8392c3bffeYWSYR8wU6WTiY6'),
    'oc://renderer/server/c2lkZWNhcg/session/ses_fc8392c3bffeYWSYR8wU6WTiY6',
  );
  assert.throws(() => buildOpenCodeInternalSessionLink('oc://renderer/server/key/session/ses_exact'), /Session ID/iu);
  assert.throws(() => buildOpenCodeInternalSessionLink('ses_exact/../../token'), /Session ID/iu);
});
