const test = require('node:test');
const assert = require('node:assert/strict');
const { createMessageId, isConfirmedPromptRejection, runLoop } = require('../src/loop');

function fakeEventStream() {
  const listeners = new Set();
  return {
    connected: true,
    waitUntilConnected() { return Promise.resolve(); },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function logger() {
  return {
    lines: [],
    banner(message) { this.lines.push(['banner', message]); },
    info(message) { this.lines.push(['info', message]); },
    warn(message) { this.lines.push(['warn', message]); },
    debug(message) { this.lines.push(['debug', message]); },
  };
}

function cfg(overrides = {}) {
  return {
    maxIterations: 4,
    retries: 0,
    retryDelayMs: 1,
    maxConsecutiveErrors: 2,
    stallTimeoutMs: 100,
    turnHardTimeoutMs: 500,
    stallTimeoutMin: 1,
    delayMs: 10000,
    errorGraceMs: 10,
    eventConnectTimeoutMs: 50,
    sentinel: '[TASK_COMPLETE]',
    todoDetection: false,
    model: null,
    agent: null,
    ...overrides,
  };
}

function assistant(id, sessionId, text, completed = true, parentID = null) {
  return {
    info: {
      id,
      sessionID: sessionId,
      role: 'assistant',
      ...(parentID ? { parentID } : {}),
      time: { created: Date.now(), ...(completed ? { completed: Date.now() + 1 } : {}) },
      tokens: { input: 1, output: 1 },
      cost: 0,
    },
    parts: [{ type: 'text', text }],
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(2);
  }
  throw new Error('waitFor timeout');
}

function harness(sessionId, stream) {
  const state = {
    messages: [],
    status: {},
    prompts: [],
    promptIds: [],
    aborts: 0,
    ambiguousPost: false,
    statusError: null,
  };
  return {
    state,
    async req(method, path, body) {
      if (method === 'GET' && path === `/session/${sessionId}/message`) return state.messages;
      if (method === 'GET' && path === '/session/status') return state.status;
      if (method === 'GET' && path === `/session/${sessionId}/todo`) return [];
      if (method === 'POST' && path === `/session/${sessionId}/prompt_async`) {
        state.prompts.push(body.parts[0].text);
        state.promptIds.push(body.messageID);
        state.status = { [sessionId]: { type: 'busy' } };
        stream.emit({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' } } });
        if (state.statusError) {
          const error = new Error(`HTTP ${state.statusError}`);
          error.status = state.statusError;
          throw error;
        }
        if (state.ambiguousPost) throw new Error('fetch failed after send');
        return null;
      }
      if (method === 'POST' && path === `/session/${sessionId}/abort`) {
        state.aborts++;
        return true;
      }
      throw new Error(`Ruta inesperada: ${method} ${path}`);
    },
  };
}

test('no envia por tiempo: continua una vez e inmediatamente tras terminal+idle', async () => {
  const sessionId = 'ses_loop';
  const stream = fakeEventStream();
  const api = harness(sessionId, stream);
  const abortCtl = new AbortController();
  const run = runLoop({
    req: api.req,
    sessionId,
    cfg: cfg(),
    firstPrompt: 'initial task',
    flag: { aborted: false, signal: abortCtl.signal },
    log: logger(),
    eventStream: stream,
  });

  await waitFor(() => api.state.prompts.length === 1);
  await delay(25);
  assert.equal(api.state.prompts.length, 1, 'no debe enviar mientras el turno sigue busy');

  api.state.messages.push(assistant('msg_1', sessionId, 'avance incompleto', true, api.state.promptIds[0]));
  stream.emit({ type: 'message.updated', properties: { info: api.state.messages[0].info } });
  await delay(10);
  assert.equal(api.state.prompts.length, 1, 'terminal persistido sin idle aun no continua');

  const idleAt = Date.now();
  api.state.status = {};
  stream.emit({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } });
  await waitFor(() => api.state.prompts.length === 2);
  assert.ok(Date.now() - idleAt < 100, 'no debe aplicar delayMs al continuar');

  api.state.messages.push(assistant('msg_2', sessionId, 'listo\n[TASK_COMPLETE]', true, api.state.promptIds[1]));
  api.state.status = {};
  stream.emit({ type: 'message.updated', properties: { info: api.state.messages[1].info } });
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });

  const result = await run;
  assert.equal(result.status, 'complete');
  assert.equal(api.state.prompts.length, 2);
  assert.match(api.state.prompts[1], /Continue working/);
  assert.equal(api.state.aborts, 0);
});

test('no envia antes de que SSE este conectado', async () => {
  const sessionId = 'ses_connect_first';
  const stream = fakeEventStream();
  let connect;
  stream.connected = false;
  stream.waitUntilConnected = () => new Promise((resolve) => { connect = resolve; });
  const api = harness(sessionId, stream);
  const run = runLoop({
    req: api.req,
    sessionId,
    cfg: cfg({ maxIterations: 1 }),
    firstPrompt: 'connect first',
    flag: { aborted: false, signal: new AbortController().signal },
    log: logger(),
    eventStream: stream,
  });

  await waitFor(() => typeof connect === 'function');
  await delay(15);
  assert.equal(api.state.prompts.length, 0);
  stream.connected = true;
  connect();
  await waitFor(() => api.state.prompts.length === 1);

  api.state.messages.push(assistant('msg_connected', sessionId, '[TASK_COMPLETE]', true, api.state.promptIds[0]));
  api.state.status = {};
  stream.emit({ type: 'message.updated', properties: { info: api.state.messages[0].info } });
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });
  assert.equal((await run).status, 'complete');
});

test('reanudar una sesion busy espera el turno existente sin inyectar prompt', async () => {
  const sessionId = 'ses_resume_busy';
  const stream = fakeEventStream();
  const api = harness(sessionId, stream);
  const running = assistant('msg_existing', sessionId, '', false);
  api.state.messages = [
    { info: { id: 'msg_user', sessionID: sessionId, role: 'user', time: { created: 1 } }, parts: [] },
    running,
  ];
  api.state.status = { [sessionId]: { type: 'busy' } };
  const run = runLoop({
    req: api.req,
    sessionId,
    cfg: cfg({ maxIterations: 1 }),
    firstPrompt: 'resume task',
    flag: { aborted: false, signal: new AbortController().signal },
    log: logger(),
    eventStream: stream,
  });

  await delay(20);
  assert.equal(api.state.prompts.length, 0);
  running.info.time.completed = Date.now();
  running.parts = [{ type: 'text', text: '[TASK_COMPLETE]' }];
  api.state.status = {};
  stream.emit({ type: 'message.updated', properties: { info: running.info } });
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });

  const result = await run;
  assert.equal(result.status, 'complete');
  assert.equal(api.state.prompts.length, 0);
});

test('timeout duro no aborta ni reenvia automaticamente', async () => {
  const sessionId = 'ses_stall';
  const stream = fakeEventStream();
  const api = harness(sessionId, stream);
  const result = await runLoop({
    req: api.req,
    sessionId,
    cfg: cfg({ maxIterations: 2, stallTimeoutMs: 10, turnHardTimeoutMs: 40 }),
    firstPrompt: 'long task',
    flag: { aborted: false, signal: new AbortController().signal },
    log: logger(),
    eventStream: stream,
  });

  assert.equal(result.status, 'error');
  assert.equal(api.state.prompts.length, 1);
  assert.equal(api.state.aborts, 0);
});

test('error de transporte ambiguo espera el turno aceptado sin duplicarlo', async () => {
  const sessionId = 'ses_ambiguous';
  const stream = fakeEventStream();
  const api = harness(sessionId, stream);
  api.state.ambiguousPost = true;
  const run = runLoop({
    req: api.req,
    sessionId,
    cfg: cfg({ maxIterations: 1 }),
    firstPrompt: 'one task',
    flag: { aborted: false, signal: new AbortController().signal },
    log: logger(),
    eventStream: stream,
  });

  await waitFor(() => api.state.prompts.length === 1);
  api.state.messages.push(assistant('msg_after_timeout', sessionId, '[TASK_COMPLETE]', true, api.state.promptIds[0]));
  api.state.status = {};
  stream.emit({ type: 'message.updated', properties: { info: api.state.messages[0].info } });
  stream.emit({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } });

  const result = await run;
  assert.equal(result.status, 'complete');
  assert.equal(api.state.prompts.length, 1);
});

test('IDs de mensaje son compatibles, monotonicos y los 5xx no se reenvian', async () => {
  const first = createMessageId(1_800_000_000_000);
  const second = createMessageId(1_800_000_000_000);
  assert.match(first, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/u);
  assert.ok(first < second);
  assert.equal(isConfirmedPromptRejection({ status: 400 }), true);
  assert.equal(isConfirmedPromptRejection({ status: 503 }), false);

  const sessionId = 'ses_http_ambiguous';
  const stream = fakeEventStream();
  const api = harness(sessionId, stream);
  api.state.statusError = 503;
  const run = runLoop({
    req: api.req, sessionId, cfg: cfg({ maxIterations: 1 }), firstPrompt: 'one task',
    flag: { aborted: false, signal: new AbortController().signal }, log: logger(), eventStream: stream,
  });
  await waitFor(() => api.state.prompts.length === 1);
  const reply = assistant('msg_after_503', sessionId, '[TASK_COMPLETE]', true, api.state.promptIds[0]);
  api.state.messages.push(reply);
  api.state.status = {};
  stream.emit({ type: 'message.updated', properties: { info: reply.info } });
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });
  assert.equal((await run).status, 'complete');
  assert.equal(api.state.prompts.length, 1);
});

test('ignora terminal ajeno y reanudar una sesion completa no inyecta prompt', async () => {
  const sessionId = 'ses_exact_parent';
  const stream = fakeEventStream();
  const api = harness(sessionId, stream);
  const run = runLoop({
    req: api.req, sessionId, cfg: cfg({ maxIterations: 1 }), firstPrompt: 'ours',
    flag: { aborted: false, signal: new AbortController().signal }, log: logger(), eventStream: stream,
  });
  await waitFor(() => api.state.promptIds.length === 1);
  const other = assistant('msg_other', sessionId, '[TASK_COMPLETE]', true, 'msg_external');
  api.state.messages.push(other);
  api.state.status = {};
  stream.emit({ type: 'message.updated', properties: { info: other.info } });
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });
  await delay(15);
  const ours = assistant('msg_ours', sessionId, '[TASK_COMPLETE]', true, api.state.promptIds[0]);
  api.state.messages.push(ours);
  stream.emit({ type: 'message.updated', properties: { info: ours.info } });
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });
  assert.equal((await run).status, 'complete');
  assert.equal(api.state.prompts.length, 1);

  const resumed = await runLoop({
    req: api.req, sessionId, cfg: cfg({ maxIterations: 1 }), firstPrompt: 'resume', resumeExisting: true,
    flag: { aborted: false, signal: new AbortController().signal }, log: logger(), eventStream: stream,
  });
  assert.equal(resumed.status, 'complete');
  assert.equal(api.state.prompts.length, 1);
});
