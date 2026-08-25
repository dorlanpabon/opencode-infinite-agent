const assert = require('node:assert/strict');
const test = require('node:test');
const { OpenCodeSessionCatalog } = require('../dist/desktop/session-catalog.js');

function eventStream() {
  const listeners = new Set();
  return {
    ready: Promise.resolve(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
    abort() {
      listeners.clear();
    },
  };
}

async function waitFor(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('waitFor timeout');
}

function harness() {
  const stream = eventStream();
  const calls = [];
  const state = {
    sessions: [{
      id: 'ses_active1', title: 'Sesión activa', directory: 'C:\\workspace',
      time: { created: 10, updated: 20 },
    }],
    statuses: { ses_active1: { type: 'busy' } },
    stops: 0,
  };
  const server = {
    findAvailableLoopbackPort: async () => 45678,
    ensureServer: async (cfg) => ({ base: String(cfg.base), owned: true, proc: {} }),
    stopServer: async () => { state.stops++; },
    request: async (_base, method, pathname) => {
      calls.push({ method, pathname });
      if (pathname === '/session') return state.sessions;
      if (pathname === '/session/status') return state.statuses;
      throw new Error(`unexpected ${method} ${pathname}`);
    },
    startEventStream: () => stream,
  };
  const config = {
    loadConfig: (input) => ({ ...input, hostname: '127.0.0.1', port: 4567, base: 'http://127.0.0.1:4567' }),
  };
  return { calls, config, server, state, stream };
}

test('catálogo combina sesiones/status y reconcilia por SSE sin escrituras ni polling', async () => {
  const api = harness();
  const catalog = new OpenCodeSessionCatalog(() => undefined, { server: api.server, config: api.config });
  const snapshots = [];
  catalog.setListener((sessions) => snapshots.push(sessions));
  const input = { workspace: 'C:\\workspace', binary: null, attach: null, sessionRef: null };
  const connected = await catalog.connect(input);

  assert.equal(connected.base, 'http://127.0.0.1:45678');
  assert.equal(connected.sessions[0].status, 'busy');
  assert.deepEqual(api.calls.map((call) => `${call.method} ${call.pathname}`), [
    'GET /session', 'GET /session/status',
  ]);

  api.state.statuses = {};
  api.stream.emit({ type: 'session.idle', properties: { sessionID: 'ses_active1' } });
  await waitFor(() => snapshots.at(-1)?.[0]?.status === 'idle');
  assert.equal(api.calls.every((call) => call.method === 'GET'), true);

  const beforeReconnect = api.calls.length;
  api.state.statuses = { ses_active1: { type: 'retry', message: 'rate limited' } };
  api.stream.emit({ type: 'server.connected', properties: {} });
  await waitFor(() => snapshots.at(-1)?.[0]?.status === 'retry');
  assert.equal(api.calls.length, beforeReconnect + 2);
  assert.equal(snapshots.at(-1)[0].retryMessage, 'rate limited');

  await catalog.close();
  assert.equal(api.state.stops, 1);
});

test('catálogo reemplaza el listener de snapshots en refresh sucesivos', async () => {
  const api = harness();
  const catalog = new OpenCodeSessionCatalog(() => undefined, { server: api.server, config: api.config });
  let oldCalls = 0;
  let currentCalls = 0;
  catalog.setListener(() => { oldCalls++; });
  catalog.setListener(() => { currentCalls++; });
  await catalog.connect({ workspace: 'C:\\workspace', binary: null, attach: null, sessionRef: null });
  assert.equal(oldCalls, 0);
  assert.equal(currentCalls, 1);
  await catalog.close();
});

test('close cancela una conexión pendiente y drena el servidor propio', async () => {
  let releaseEnsure;
  let ensureSignal = null;
  let stops = 0;
  const ensureGate = new Promise((resolve) => { releaseEnsure = resolve; });
  const server = {
    findAvailableLoopbackPort: async () => 45679,
    ensureServer: async (_cfg, _log, options) => {
      ensureSignal = options.signal;
      return ensureGate;
    },
    stopServer: async () => { stops++; },
    request: async (_base, _method, pathname) => pathname === '/session' ? [] : {},
    startEventStream: () => eventStream(),
  };
  const config = { loadConfig: (input) => ({ ...input }) };
  const input = { workspace: 'C:\\workspace', binary: null, attach: null, sessionRef: null };
  const catalog = new OpenCodeSessionCatalog(() => undefined, { server, config });
  const connecting = catalog.connect(input);
  const rejected = assert.rejects(connecting, /cancelada|cerrado/iu);
  await waitFor(() => ensureSignal instanceof AbortSignal);

  const closing = catalog.close();
  assert.equal(ensureSignal.aborted, true);
  releaseEnsure({ base: 'http://127.0.0.1:45679', owned: true, proc: {} });
  await Promise.all([rejected, closing]);

  assert.equal(stops, 1);
  assert.equal(catalog.matches(input), false);
  assert.deepEqual(catalog.current(), []);
});
