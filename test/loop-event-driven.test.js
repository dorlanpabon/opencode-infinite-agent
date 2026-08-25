const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMessageBody, hasUnsafeWrappedHistory, isConfirmedPromptRejection, runLoop } = require('../src/loop');

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

function user(id, sessionId, text, created = Date.now()) {
  return {
    info: { id, sessionID: sessionId, role: 'user', time: { created } },
    parts: Array.isArray(text) ? text : [{ type: 'text', text }],
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
    promptBodies: [],
    promptIds: [],
    aborts: 0,
    ambiguousPost: false,
    statusError: null,
    failStatus: 0,
    statusCalls: 0,
    failMessages: 0,
    nextPrompt: 0,
  };
  return {
    state,
    async req(method, path, body) {
      if (method === 'GET' && path === `/session/${sessionId}/message`) {
        if (state.failMessages > 0) {
          state.failMessages--;
          throw new Error('fallo transitorio de mensajes');
        }
        return state.messages;
      }
      if (method === 'GET' && path === '/session/status') {
        state.statusCalls++;
        if (state.failStatus > 0) {
          state.failStatus--;
          throw new Error('fallo transitorio de status');
        }
        return state.status;
      }
      if (method === 'GET' && path === `/session/${sessionId}/todo`) return [];
      if (method === 'POST' && path === `/session/${sessionId}/prompt_async`) {
        state.prompts.push(body.parts[0].text);
        state.promptBodies.push(body);
        state.nextPrompt++;
        const userId = `msg_${state.nextPrompt.toString(16).padStart(12, '0')}${'a'.repeat(14)}`;
        state.promptIds.push(userId);
        state.messages.push(user(userId, sessionId, body.parts.map((part) => ({ ...part }))));
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

  const firstReply = assistant('msg_1', sessionId, 'avance incompleto', true, api.state.promptIds[0]);
  api.state.messages.push(firstReply);
  stream.emit({ type: 'message.updated', properties: { info: firstReply.info } });
  await delay(10);
  assert.equal(api.state.prompts.length, 1, 'terminal persistido sin idle aun no continua');

  const idleAt = Date.now();
  api.state.status = {};
  stream.emit({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } });
  await waitFor(() => api.state.prompts.length === 2);
  assert.ok(Date.now() - idleAt < 100, 'no debe aplicar delayMs al continuar');

  const secondReply = assistant('msg_2', sessionId, 'listo\n[TASK_COMPLETE]', true, api.state.promptIds[1]);
  api.state.messages.push(secondReply);
  api.state.status = {};
  stream.emit({ type: 'message.updated', properties: { info: secondReply.info } });
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });

  const result = await run;
  assert.equal(result.status, 'complete');
  assert.equal(api.state.prompts.length, 2);
  assert.match(api.state.prompts[1], /Continue working/);
  assert.equal(api.state.aborts, 0);
});

test('al activar una sesión ocupada espera idle, envía el objetivo y adjunta archivos solo una vez', async () => {
  const sessionId = 'ses_activate_objective';
  const stream = fakeEventStream();
  const api = harness(sessionId, stream);
  const running = assistant('msg_existing_work', sessionId, '', false, 'msg_existing_user');
  api.state.messages = [user('msg_existing_user', sessionId, 'objetivo anterior'), running];
  api.state.status = { [sessionId]: { type: 'busy' } };
  const attachment = {
    path: require('node:path').resolve('brief.md'),
    name: 'brief.md',
    mime: 'text/plain',
    size: 10,
  };
  let attachmentValidations = 0;
  const run = runLoop({
    req: api.req,
    sessionId,
    cfg: cfg({ maxIterations: 2, model: 'openai/gpt-5.4' }),
    firstPrompt: 'nuevo objetivo verificable',
    firstAttachments: [attachment],
    resumeExisting: true,
    replaceObjective: true,
    beforeFirstPrompt: async () => { attachmentValidations++; },
    flag: { aborted: false, signal: new AbortController().signal },
    log: logger(),
    eventStream: stream,
  });

  await delay(20);
  assert.equal(api.state.prompts.length, 0);
  assert.equal(attachmentValidations, 0);
  running.info.time.completed = Date.now();
  running.parts = [{ type: 'text', text: 'turno anterior listo' }];
  api.state.status = {};
  stream.emit({ type: 'message.updated', properties: { info: running.info } });
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });
  await waitFor(() => api.state.prompts.length === 1);
  assert.equal(attachmentValidations, 1);
  assert.equal(api.state.prompts[0], 'nuevo objetivo verificable');
  assert.deepEqual(api.state.promptBodies[0].model, { providerID: 'openai', modelID: 'gpt-5.4' });
  assert.deepEqual(api.state.promptBodies[0].parts[1], {
    type: 'file',
    mime: 'text/plain',
    filename: 'brief.md',
    url: require('node:url').pathToFileURL(attachment.path).href,
  });

  const firstReply = assistant('msg_new_incomplete', sessionId, 'falta verificar', true, api.state.promptIds[0]);
  api.state.messages.push(firstReply);
  api.state.status = {};
  stream.emit({ type: 'message.updated', properties: { info: firstReply.info } });
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });
  await waitFor(() => api.state.prompts.length === 2);
  assert.equal(api.state.promptBodies[1].parts.some((part) => part.type === 'file'), false);

  const finalReply = assistant('msg_new_done', sessionId, '[TASK_COMPLETE]', true, api.state.promptIds[1]);
  api.state.messages.push(finalReply);
  api.state.status = {};
  stream.emit({ type: 'message.updated', properties: { info: finalReply.info } });
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });
  assert.equal((await run).status, 'complete');
});

test('recover-first-prompt espera un turno ajeno y luego envía el objetivo durable', async () => {
  const sessionId = 'ses_recover_before_send';
  const marker = '<!-- opencode-infinite-agent-turn:11111111-1111-4111-8111-111111111111 -->';
  const stream = fakeEventStream();
  const api = harness(sessionId, stream);
  const running = assistant('msg_previous_work', sessionId, '', false, 'msg_previous_user');
  api.state.messages = [user('msg_previous_user', sessionId, 'turno manual anterior'), running];
  api.state.status = { [sessionId]: { type: 'busy' } };
  const run = runLoop({
    req: api.req,
    sessionId,
    cfg: cfg({ maxIterations: 1 }),
    firstPrompt: 'objetivo que aún no se había enviado',
    firstPromptMarker: marker,
    recoverPromptMarker: marker,
    resumeExisting: true,
    flag: { aborted: false, signal: new AbortController().signal },
    log: logger(),
    eventStream: stream,
  });

  await delay(20);
  assert.equal(api.state.prompts.length, 0);
  running.info.time.completed = Date.now();
  running.parts = [{ type: 'text', text: '[TASK_COMPLETE] ajeno' }];
  api.state.status = {};
  stream.emit({ type: 'message.updated', properties: { info: running.info } });
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });
  await waitFor(() => api.state.prompts.length === 1);
  assert.equal(api.state.prompts[0], 'objetivo que aún no se había enviado');
  assert.equal(api.state.promptBodies[0].parts.at(-1).text, marker);

  const reply = assistant('msg_recovered_reply', sessionId, '[TASK_COMPLETE]', true, api.state.promptIds[0]);
  api.state.messages.push(reply);
  api.state.status = {};
  stream.emit({ type: 'message.updated', properties: { info: reply.info } });
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });
  assert.equal((await run).status, 'complete');
  assert.equal(api.state.prompts.length, 1);
});

test('recover-first-prompt adopta por marca durable una respuesta ya aceptada sin repetir objetivo', async () => {
  const sessionId = 'ses_recover_accepted';
  const marker = '<!-- opencode-infinite-agent-turn:22222222-2222-4222-8222-222222222222 -->';
  const stream = fakeEventStream();
  const api = harness(sessionId, stream);
  const body = buildMessageBody(cfg(), 'objetivo original', [], marker);
  api.state.messages = [
    user('msg_original_user', sessionId, body.parts),
    assistant('msg_original_reply', sessionId, '[TASK_COMPLETE]', true, 'msg_original_user'),
  ];
  api.state.status = {};

  const result = await runLoop({
    req: api.req,
    sessionId,
    cfg: cfg({ maxIterations: 1 }),
    firstPrompt: 'objetivo original',
    firstPromptMarker: marker,
    recoverPromptMarker: marker,
    resumeExisting: true,
    flag: { aborted: false, signal: new AbortController().signal },
    log: logger(),
    eventStream: stream,
  });
  assert.equal(result.status, 'complete');
  assert.equal(api.state.prompts.length, 0);
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

  const connectedReply = assistant('msg_connected', sessionId, '[TASK_COMPLETE]', true, api.state.promptIds[0]);
  api.state.messages.push(connectedReply);
  api.state.status = {};
  stream.emit({ type: 'message.updated', properties: { info: connectedReply.info } });
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });
  assert.equal((await run).status, 'complete');
});

test('reanudar adopta un turno sin resolver aunque status figure idle', async () => {
  const sessionId = 'ses_resume_busy';
  const stream = fakeEventStream();
  const api = harness(sessionId, stream);
  const running = assistant('msg_existing', sessionId, '', false, 'msg_user');
  api.state.messages = [
    user('msg_user', sessionId, 'tarea ya activa'),
    running,
  ];
  api.state.status = {};
  const run = runLoop({
    req: api.req,
    sessionId,
    cfg: cfg({ maxIterations: 1 }),
    firstPrompt: 'resume task',
    resumeExisting: true,
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

test('busy desfasado espera idle y adopta el terminal ya persistido', async () => {
  const sessionId = 'ses_stale_busy';
  const stream = fakeEventStream();
  const api = harness(sessionId, stream);
  api.state.messages = [
    user('msg_stale_user', sessionId, 'old task', 1),
    assistant('msg_stale_terminal', sessionId, '[TASK_COMPLETE]', true, 'msg_stale_user'),
  ];
  api.state.status = { [sessionId]: { type: 'busy' } };
  const run = runLoop({
    req: api.req, sessionId, cfg: cfg({ maxIterations: 1 }), firstPrompt: 'resume', resumeExisting: true,
    flag: { aborted: false, signal: new AbortController().signal }, log: logger(), eventStream: stream,
  });

  await delay(20);
  assert.equal(api.state.prompts.length, 0);
  api.state.status = {};
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });
  assert.equal((await run).status, 'complete');
  assert.equal(api.state.prompts.length, 0);
});

test('una tarea nueva espera el busy correlacionado y despues envia su prompt', async () => {
  const sessionId = 'ses_busy_then_new';
  const stream = fakeEventStream();
  const api = harness(sessionId, stream);
  const running = assistant('msg_existing_work', sessionId, '', false, 'msg_existing_user');
  api.state.messages = [user('msg_existing_user', sessionId, 'old task'), running];
  api.state.status = { [sessionId]: { type: 'busy' } };
  const run = runLoop({
    req: api.req,
    sessionId,
    cfg: cfg({ maxIterations: 1 }),
    firstPrompt: 'fresh task',
    flag: { aborted: false, signal: new AbortController().signal },
    log: logger(),
    eventStream: stream,
  });

  await delay(20);
  assert.equal(api.state.prompts.length, 0);
  running.info.time.completed = Date.now();
  running.parts = [{ type: 'text', text: 'old done' }];
  api.state.status = {};
  stream.emit({ type: 'message.updated', properties: { info: running.info } });
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });
  await waitFor(() => api.state.prompts.length === 1);
  assert.equal(api.state.prompts[0], 'fresh task');

  const reply = assistant('msg_fresh_reply', sessionId, '[TASK_COMPLETE]', true, api.state.promptIds[0]);
  api.state.messages.push(reply);
  api.state.status = {};
  stream.emit({ type: 'message.updated', properties: { info: reply.info } });
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });
  assert.equal((await run).status, 'complete');
  assert.equal(api.state.prompts.length, 1);
});

test('una tarea nueva espera un turno incompleto aunque status figure idle', async () => {
  const sessionId = 'ses_idle_unresolved';
  const stream = fakeEventStream();
  const api = harness(sessionId, stream);
  const running = assistant('msg_idle_work', sessionId, '', false, 'msg_idle_user');
  api.state.messages = [user('msg_idle_user', sessionId, 'old task'), running];
  api.state.status = {};
  const run = runLoop({
    req: api.req, sessionId, cfg: cfg({ maxIterations: 1 }), firstPrompt: 'new task',
    flag: { aborted: false, signal: new AbortController().signal }, log: logger(), eventStream: stream,
  });

  await delay(20);
  assert.equal(api.state.prompts.length, 0);
  running.info.time.completed = Date.now();
  running.parts = [{ type: 'text', text: 'old done' }];
  stream.emit({ type: 'message.updated', properties: { info: running.info } });
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });
  await waitFor(() => api.state.prompts.length === 1);

  const reply = assistant('msg_new_done', sessionId, '[TASK_COMPLETE]', true, api.state.promptIds[0]);
  api.state.messages.push(reply);
  api.state.status = {};
  stream.emit({ type: 'message.updated', properties: { info: reply.info } });
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });
  assert.equal((await run).status, 'complete');
  assert.equal(api.state.prompts.length, 1);
});

test('falla cerrado si status idle contiene multiples turnos sin resolver', async () => {
  const sessionId = 'ses_idle_ambiguous';
  const stream = fakeEventStream();
  const api = harness(sessionId, stream);
  api.state.messages = [
    user('msg_open_a', sessionId, 'a'),
    user('msg_open_b', sessionId, 'b'),
  ];
  api.state.status = {};

  const result = await runLoop({
    req: api.req, sessionId, cfg: cfg({ maxIterations: 1 }), firstPrompt: 'must not send',
    flag: { aborted: false, signal: new AbortController().signal }, log: logger(), eventStream: stream,
  });
  assert.equal(result.status, 'error');
  assert.match(result.reason, /multiples turnos.*sin resolver/);
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

test('fallo transitorio del watchdog no rechaza ni reenvia el prompt aceptado', async () => {
  const sessionId = 'ses_watchdog_repair';
  const stream = fakeEventStream();
  const api = harness(sessionId, stream);
  const run = runLoop({
    req: api.req,
    sessionId,
    cfg: cfg({ maxIterations: 1, retries: 2, stallTimeoutMs: 10, turnHardTimeoutMs: 200 }),
    firstPrompt: 'single dispatch',
    flag: { aborted: false, signal: new AbortController().signal },
    log: logger(),
    eventStream: stream,
  });
  await waitFor(() => api.state.prompts.length === 1);
  api.state.failMessages = 1;
  await delay(18);

  const reply = assistant('msg_watchdog_done', sessionId, '[TASK_COMPLETE]', true, api.state.promptIds[0]);
  api.state.messages.push(reply);
  api.state.status = {};
  stream.emit({ type: 'message.updated', properties: { info: reply.info } });
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });
  assert.equal((await run).status, 'complete');
  assert.equal(api.state.prompts.length, 1);
});

test('fallo transitorio de status antes del POST reintenta sin enviar a ciegas', async () => {
  const sessionId = 'ses_preflight_status_retry';
  const stream = fakeEventStream();
  const api = harness(sessionId, stream);
  api.state.failStatus = 1;
  const run = runLoop({
    req: api.req,
    sessionId,
    cfg: cfg({ maxIterations: 1, retries: 0, maxConsecutiveErrors: 3 }),
    firstPrompt: 'safe retry',
    flag: { aborted: false, signal: new AbortController().signal },
    log: logger(),
    eventStream: stream,
  });

  await waitFor(() => api.state.prompts.length === 1);
  assert.ok(api.state.statusCalls >= 2);
  assert.equal(api.state.prompts[0], 'safe retry');
  const reply = assistant('msg_safe_retry_done', sessionId, '[TASK_COMPLETE]', true, api.state.promptIds[0]);
  api.state.messages.push(reply);
  api.state.status = {};
  stream.emit({ type: 'message.updated', properties: { info: reply.info } });
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });
  assert.equal((await run).status, 'complete');
  assert.equal(api.state.prompts.length, 1);
});

test('errores terminales consecutivos del proveedor detienen el ciclo', async () => {
  const sessionId = 'ses_provider_errors';
  const stream = fakeEventStream();
  const api = harness(sessionId, stream);
  const run = runLoop({
    req: api.req,
    sessionId,
    cfg: cfg({ maxIterations: 4, maxConsecutiveErrors: 2 }),
    firstPrompt: 'provider failure task',
    flag: { aborted: false, signal: new AbortController().signal },
    log: logger(),
    eventStream: stream,
  });

  for (let index = 0; index < 2; index++) {
    await waitFor(() => api.state.prompts.length === index + 1);
    const reply = assistant(`msg_provider_error_${index}`, sessionId, '', true, api.state.promptIds[index]);
    reply.info.error = { name: 'APIError', data: { message: 'provider unavailable' } };
    api.state.messages.push(reply);
    api.state.status = {};
    stream.emit({ type: 'message.updated', properties: { info: reply.info } });
    stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });
  }

  const result = await run;
  assert.equal(result.status, 'error');
  assert.match(result.reason, /Errores repetidos/);
  assert.equal(api.state.prompts.length, 2);
});

test('un error no reintentable del proveedor detiene el ciclo tras el primer turno', async () => {
  const sessionId = 'ses_provider_non_retryable';
  const stream = fakeEventStream();
  const api = harness(sessionId, stream);
  const run = runLoop({
    req: api.req,
    sessionId,
    cfg: cfg({ maxIterations: 8, maxConsecutiveErrors: 5 }),
    firstPrompt: 'provider balance task',
    flag: { aborted: false, signal: new AbortController().signal },
    log: logger(),
    eventStream: stream,
  });

  await waitFor(() => api.state.prompts.length === 1);
  const reply = assistant('msg_provider_balance', sessionId, '', true, api.state.promptIds[0]);
  reply.info.error = {
    name: 'APIError',
    data: { message: 'Insufficient Balance', statusCode: 402, isRetryable: false },
  };
  api.state.messages.push(reply);
  api.state.status = {};
  stream.emit({ type: 'message.updated', properties: { info: reply.info } });
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });

  const result = await run;
  assert.equal(result.status, 'error');
  assert.match(result.reason, /no reintentable.*402.*Insufficient Balance/iu);
  assert.equal(api.state.prompts.length, 1);
});

test('un error terminal del proveedor redacta secretos antes de logs y estado', async () => {
  const sessionId = 'ses_provider_secret';
  const stream = fakeEventStream();
  const api = harness(sessionId, stream);
  const log = logger();
  const stateEvents = [];
  const secrets = ['provider-token-raw', 'provider-api-key-raw', 'provider-auth-raw', 'url-user', 'url-password'];
  const message = 'token=provider-token-raw api_key=provider-api-key-raw '
    + 'Authorization: Bearer provider-auth-raw https://url-user:url-password@example.test/v1';
  const run = runLoop({
    req: api.req,
    sessionId,
    cfg: cfg({ maxIterations: 8, maxConsecutiveErrors: 5 }),
    firstPrompt: 'provider secret task',
    flag: { aborted: false, signal: new AbortController().signal },
    log,
    eventStream: stream,
    onState: (event) => stateEvents.push(event),
  });

  await waitFor(() => api.state.prompts.length === 1);
  const reply = assistant('msg_provider_secret', sessionId, message, true, api.state.promptIds[0]);
  reply.info.error = {
    name: 'APIError',
    data: { message, statusCode: 402, isRetryable: false },
  };
  api.state.messages.push(reply);
  api.state.status = {};
  stream.emit({ type: 'message.updated', properties: { info: reply.info } });
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });

  const result = await run;
  const exposed = JSON.stringify({ logs: log.lines, result, stateEvents });
  assert.equal(result.status, 'error');
  assert.match(result.reason, /APIError 402/);
  assert.match(exposed, /\[REDACTED\]/u);
  for (const secret of secrets) assert.equal(exposed.includes(secret), false, secret);
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
  const timeoutReply = assistant('msg_after_timeout', sessionId, '[TASK_COMPLETE]', true, api.state.promptIds[0]);
  api.state.messages.push(timeoutReply);
  api.state.status = {};
  stream.emit({ type: 'message.updated', properties: { info: timeoutReply.info } });
  stream.emit({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } });

  const result = await run;
  assert.equal(result.status, 'complete');
  assert.equal(api.state.prompts.length, 1);
});

test('delega IDs al servidor, detecta wrap historico y no reenvia 5xx', async () => {
  const firstBody = buildMessageBody(cfg(), 'task');
  const secondBody = buildMessageBody(cfg(), 'task');
  assert.equal(Object.hasOwn(firstBody, 'messageID'), false);
  assert.equal(firstBody.parts.length, 2);
  assert.deepEqual(firstBody.parts[0], { type: 'text', text: 'task' });
  assert.equal(firstBody.parts[1].synthetic, true);
  assert.equal(firstBody.parts[1].ignored, true);
  assert.match(firstBody.parts[1].text, /^<!-- opencode-infinite-agent-turn:[0-9a-f-]{36} -->$/);
  assert.notEqual(firstBody.parts[1].text, secondBody.parts[1].text);
  const now = 1_800_000_000_000;
  assert.equal(hasUnsafeWrappedHistory([
    user(`msg_ffffffffffff${'a'.repeat(14)}`, 'ses_old', 'old', now - 120000),
  ], now), true);
  assert.equal(hasUnsafeWrappedHistory([
    user(`msg_000000000001${'a'.repeat(14)}`, 'ses_new', 'new', now - 120000),
  ], now), false);
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
