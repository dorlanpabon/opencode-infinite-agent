const assert = require('node:assert/strict');
const test = require('node:test');
const { loadConfig, normalizeLoopbackUrl } = require('../src/config');

test('attach solo acepta origen loopback sin credenciales ni rutas', () => {
  assert.equal(normalizeLoopbackUrl('http://127.0.0.1:4096/'), 'http://127.0.0.1:4096');
  assert.equal(normalizeLoopbackUrl('https://localhost:4096'), 'https://localhost:4096');
  assert.throws(() => normalizeLoopbackUrl('https://example.com'), /loopback/iu);
  assert.throws(() => normalizeLoopbackUrl('http://user:secret@127.0.0.1:4096'), /loopback/iu);
  assert.throws(() => normalizeLoopbackUrl('http://127.0.0.1:4096/api'), /loopback/iu);
});

test('servidor administrado no puede exponerse a la red', () => {
  assert.throws(() => loadConfig({ hostname: '0.0.0.0' }), /no se expone/iu);
});

test('limites event-driven aceptan overrides sin reactivar polling', () => {
  const cfg = loadConfig({
    turnHardTimeoutMin: 90,
    eventConnectTimeoutMs: 5000,
    errorGraceMs: 600,
    noTodos: true,
  });
  assert.equal(cfg.turnHardTimeoutMs, 90 * 60 * 1000);
  assert.equal(cfg.eventConnectTimeoutMs, 5000);
  assert.equal(cfg.errorGraceMs, 600);
  assert.equal(cfg.todoDetection, false);
});
