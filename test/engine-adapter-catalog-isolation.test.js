const assert = require('node:assert/strict');
const test = require('node:test');

const { createOpenCodeEngineAdapter } = require('../dist/desktop/engine-adapter.js');

test('modelos y contexto históricos no reemplazan el catálogo visible de sesiones', async () => {
  const workspace = process.cwd();
  const visible = [{
    id: 'ses_visible_desktop', title: 'Visible', workspace,
    createdAt: new Date(0).toISOString(), updatedAt: new Date(1).toISOString(),
    status: 'idle', retryMessage: null, continuous: false, runId: null,
  }];
  let desktopListener = () => undefined;
  const desktopCatalog = {
    connected: true,
    setListener(listener) { desktopListener = listener; },
    async connect() {
      desktopListener(visible);
      return { sessions: visible };
    },
    endpointForSession() { throw new Error('not used'); },
    async reconcile() { return visible; },
    async models() { return { models: [], configuredModel: null }; },
    async context() { return { sessionId: 'ses_visible_desktop', messages: [] }; },
    async close() {},
  };
  let mainConnects = 0;
  const serverCatalog = {
    setListener() {},
    matches() { return false; },
    async connect() { mainConnects += 1; return { base: 'http://127.0.0.1:1', sessions: [] }; },
    async reconcile() { return []; },
    async models() { return { models: [], configuredModel: null }; },
    async context() { throw new Error('main context must stay untouched'); },
    async close() {},
  };
  let transientConnects = 0;
  let transientCloses = 0;
  const createServerCatalog = () => ({
    setListener() {},
    matches() { return false; },
    async connect() { transientConnects += 1; return { base: 'http://127.0.0.1:2', sessions: [] }; },
    async reconcile() { return []; },
    async models() { return { models: [{ id: 'provider/model' }], configuredModel: null }; },
    async context(sessionId) { return { sessionId, messages: [{ role: 'assistant', text: 'histórico' }] }; },
    async close() { transientCloses += 1; },
  });
  const adapter = createOpenCodeEngineAdapter({ serverCatalog, createServerCatalog, desktopCatalog });
  const snapshots = [];
  const desktopInput = { workspace, binary: null, attach: null, sessionRef: null };
  await adapter.listSessions(desktopInput, (sessions) => snapshots.push(sessions));

  const models = await adapter.listModels({
    workspace, binary: null, attach: 'http://127.0.0.1:4567', sessionRef: null,
  });
  const context = await adapter.getSessionContext({
    workspace, binary: null, attach: null, sessionRef: null,
    connectionMode: 'dedicated', sessionId: 'ses_historical', limit: 20,
  });

  assert.equal(models.models[0].id, 'provider/model');
  assert.equal(context.sessionId, 'ses_historical');
  assert.equal(mainConnects, 0);
  assert.equal(transientConnects, 2);
  assert.equal(transientCloses, 2);
  assert.deepEqual(snapshots.at(-1), visible);
  await adapter.shutdown();
});

test('el intento de turno no avanza la iteración durable antes de una respuesta terminal', async () => {
  const workspace = process.cwd();
  const serverCatalog = {
    setListener() {}, matches() { return true; },
    async connect() { return { base: 'http://127.0.0.1:4567', sessions: [] }; },
    async reconcile() { return []; }, async models() { return { models: [], configuredModel: null }; },
    async context(sessionId) { return { sessionId, messages: [] }; }, async close() {},
  };
  const desktopCatalog = {
    connected: false, setListener() {}, async connect() { return { sessions: [] }; },
    endpointForSession() { throw new Error('not used'); }, async reconcile() { return []; },
    async models() { return { models: [], configuredModel: null }; },
    async context(sessionId) { return { sessionId, messages: [] }; }, async close() {},
  };
  let releaseAgent;
  const agentGate = new Promise((resolve) => { releaseAgent = resolve; });
  const agentModule = {
    async executeAgent(_input, options) {
      await options.onSession('ses_iteration_gate');
      options.onState({ phase: 'working', iteration: 1 });
      await agentGate;
      return {
        status: 'complete', reason: 'done', sessionId: 'ses_iteration_gate',
        state: { iterations: 1, tokens: { input: 1, output: 1 }, cost: 0, lastText: 'done' },
      };
    },
  };
  const adapter = createOpenCodeEngineAdapter({ serverCatalog, desktopCatalog, agentModule });
  const events = [];
  const execution = adapter.run({
    task: 'objetivo', attachments: [], workspace, name: 'Prueba', sessionRef: null,
    model: null, agent: null, binary: null, attach: null, maxIterations: 2,
    maxHours: 1, stallMinutes: 1, sentinel: '[TASK_COMPLETE]', todoDetection: false,
    autoApprove: false, autoApproveConfirmation: false, resumeExisting: false,
    connectionMode: 'dedicated', recoveryMode: 'new-objective',
    firstPromptMarker: '<!-- opencode-infinite-agent-turn:33333333-3333-4333-8333-333333333333 -->',
    firstPromptKind: 'objective',
  }, {
    runId: '33333333-3333-4333-8333-333333333333',
    operationId: '44444444-4444-4444-8444-444444444444',
    signal: new AbortController().signal,
    async emit(event) { events.push(event); },
  });

  while (!events.some((event) => event.type === 'phase' && event.status === 'working')) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(events.some((event) => event.type === 'progress'), false);
  releaseAgent();
  assert.equal((await execution).status, 'completed');
  assert.equal(events.filter((event) => event.type === 'progress').at(-1).iteration, 1);
  await adapter.shutdown();
});
