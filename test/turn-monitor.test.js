const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createSessionTurnMonitor,
  SessionTurnError,
} = require('../src/turn-monitor');

function fakeEventStream() {
  const listeners = new Set();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function backend(sessionId) {
  const state = { messages: [], status: {}, failMessages: false };
  const calls = [];
  return {
    state,
    calls,
    async req(method, path) {
      calls.push({ method, path });
      if (path === `/session/${sessionId}/message`) {
        if (state.failMessages) throw new Error('fallo transitorio');
        return state.messages;
      }
      if (path === '/session/status') return state.status;
      throw new Error(`Ruta inesperada: ${method} ${path}`);
    },
  };
}

function assistant(id, sessionId, { completed = true, error = null, text = 'ok', parentID = null } = {}) {
  return {
    info: {
      id,
      sessionID: sessionId,
      role: 'assistant',
      ...(parentID ? { parentID } : {}),
      time: { created: 1, ...(completed ? { completed: 2 } : {}) },
      ...(error ? { error } : {}),
    },
    parts: [{ type: 'text', text }],
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertPending(promise, ms = 15) {
  const state = await Promise.race([
    promise.then(() => 'resolved', () => 'rejected'),
    delay(ms).then(() => 'pending'),
  ]);
  assert.equal(state, 'pending');
}

test('requiere assistant terminal persistido e idle antes de resolver', async () => {
  const sessionId = 'ses_target';
  const stream = fakeEventStream();
  const api = backend(sessionId);
  api.state.status = { [sessionId]: { type: 'busy' } };
  const monitor = createSessionTurnMonitor({ req: api.req, eventStream: stream, sessionId, errorGraceMs: 10 });
  const ticket = monitor.waitForTerminal({ knownMessageIds: [], timeoutMs: 100, hardTimeoutMs: 500 });

  api.state.messages = [assistant('msg_done', sessionId)];
  stream.emit({ type: 'message.updated', properties: { info: api.state.messages[0].info } });
  await assertPending(ticket.promise);

  api.state.status = {};
  stream.emit({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } });
  const reply = await ticket.promise;
  assert.equal(reply.info.id, 'msg_done');
  monitor.close();
});

test('acepta session.idle legado y deduplica eventos terminales', async () => {
  const sessionId = 'ses_legacy';
  const stream = fakeEventStream();
  const api = backend(sessionId);
  api.state.status = { [sessionId]: { type: 'busy' } };
  const monitor = createSessionTurnMonitor({ req: api.req, eventStream: stream, sessionId });
  const ticket = monitor.waitForTerminal({ knownMessageIds: [], timeoutMs: 100, hardTimeoutMs: 500 });

  api.state.messages = [assistant('msg_legacy', sessionId)];
  api.state.status = {};
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });
  stream.emit({ type: 'message.updated', properties: { info: api.state.messages[0].info } });
  stream.emit({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } });

  const reply = await ticket.promise;
  assert.equal(reply.info.id, 'msg_legacy');
  await delay(5);
  assert.equal(monitor.active, null);
  monitor.close();
});

test('ignora eventos de otras sesiones', async () => {
  const sessionId = 'ses_target';
  const stream = fakeEventStream();
  const api = backend(sessionId);
  api.state.status = { [sessionId]: { type: 'busy' } };
  const monitor = createSessionTurnMonitor({ req: api.req, eventStream: stream, sessionId });
  const ticket = monitor.waitForTerminal({ knownMessageIds: [], timeoutMs: 100, hardTimeoutMs: 500 });

  api.state.messages = [assistant('msg_target', sessionId)];
  stream.emit({ type: 'session.status', properties: { sessionID: 'ses_other', status: { type: 'idle' } } });
  await assertPending(ticket.promise);

  api.state.status = {};
  stream.emit({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } });
  assert.equal((await ticket.promise).info.id, 'msg_target');
  monitor.close();
});

test('server.connected reconcilia un terminal perdido durante reconexion', async () => {
  const sessionId = 'ses_reconnect';
  const stream = fakeEventStream();
  const api = backend(sessionId);
  api.state.status = { [sessionId]: { type: 'busy' } };
  const monitor = createSessionTurnMonitor({ req: api.req, eventStream: stream, sessionId });
  const ticket = monitor.waitForTerminal({ knownMessageIds: [], timeoutMs: 100, hardTimeoutMs: 500 });

  api.state.messages = [assistant('msg_recovered', sessionId)];
  api.state.status = {};
  stream.emit({ type: 'server.connected', properties: {} });

  assert.equal((await ticket.promise).info.id, 'msg_recovered');
  monitor.close();
});

test('session.error espera grace para recoger el error persistido', async () => {
  const sessionId = 'ses_error_persisted';
  const stream = fakeEventStream();
  const api = backend(sessionId);
  api.state.status = { [sessionId]: { type: 'busy' } };
  const monitor = createSessionTurnMonitor({ req: api.req, eventStream: stream, sessionId, errorGraceMs: 30 });
  const ticket = monitor.waitForTerminal({ knownMessageIds: [], timeoutMs: 100, hardTimeoutMs: 500 });

  stream.emit({
    type: 'session.error',
    properties: { sessionID: sessionId, error: { data: { message: 'provider failed' } } },
  });
  api.state.messages = [assistant('msg_error', sessionId, { error: { name: 'ProviderError' } })];
  api.state.status = {};
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });

  const reply = await ticket.promise;
  assert.equal(reply.info.id, 'msg_error');
  assert.equal(reply.info.error.name, 'ProviderError');
  monitor.close();
});

test('session.error con retry sigue esperando y no falla al vencer grace', async () => {
  const sessionId = 'ses_retry';
  const stream = fakeEventStream();
  const api = backend(sessionId);
  api.state.status = { [sessionId]: { type: 'busy' } };
  const monitor = createSessionTurnMonitor({ req: api.req, eventStream: stream, sessionId, errorGraceMs: 10 });
  const ticket = monitor.waitForTerminal({ knownMessageIds: [], timeoutMs: 40, hardTimeoutMs: 500 });

  stream.emit({ type: 'session.error', properties: { sessionID: sessionId, error: { message: 'rate limit' } } });
  api.state.status = { [sessionId]: { type: 'retry', next: Date.now() + 10 } };
  stream.emit({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'retry', next: 10 } } });
  await delay(20);
  await assertPending(ticket.promise, 5);

  api.state.messages = [assistant('msg_after_retry', sessionId)];
  api.state.status = {};
  stream.emit({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } });
  assert.equal((await ticket.promise).info.id, 'msg_after_retry');
  monitor.close();
});

test('session.error idle sin mensaje terminal falla despues del grace', async () => {
  const sessionId = 'ses_empty_error';
  const stream = fakeEventStream();
  const api = backend(sessionId);
  api.state.status = {};
  const monitor = createSessionTurnMonitor({ req: api.req, eventStream: stream, sessionId, errorGraceMs: 10 });
  const ticket = monitor.waitForTerminal({ knownMessageIds: [], timeoutMs: 100, hardTimeoutMs: 500 });

  stream.emit({
    type: 'session.error',
    properties: { sessionID: sessionId, error: { data: { message: 'startup failed' } } },
  });
  await assert.rejects(ticket.promise, (error) => {
    assert.ok(error instanceof SessionTurnError);
    assert.match(error.message, /startup failed/);
    return true;
  });
  monitor.close();
});

test('busy supera varios watchdog suaves sin convertirse en reenvio', async () => {
  const sessionId = 'ses_long';
  const stream = fakeEventStream();
  const api = backend(sessionId);
  api.state.status = { [sessionId]: { type: 'busy' } };
  const monitor = createSessionTurnMonitor({ req: api.req, eventStream: stream, sessionId });
  const ticket = monitor.waitForTerminal({ knownMessageIds: [], timeoutMs: 10, hardTimeoutMs: 150 });

  await delay(35);
  await assertPending(ticket.promise, 5);
  api.state.messages = [assistant('msg_long_done', sessionId)];
  api.state.status = {};
  stream.emit({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } });

  assert.equal((await ticket.promise).info.id, 'msg_long_done');
  monitor.close();
});

test('correlaciona el terminal con el user message exacto', async () => {
  const sessionId = 'ses_parent';
  const stream = fakeEventStream();
  const api = backend(sessionId);
  const monitor = createSessionTurnMonitor({ req: api.req, eventStream: stream, sessionId });
  const ticket = monitor.waitForTerminal({
    knownMessageIds: [], expectedParentId: 'msg_ours', timeoutMs: 100, hardTimeoutMs: 500,
  });

  api.state.messages = [assistant('msg_other_reply', sessionId, { parentID: 'msg_other' })];
  api.state.status = {};
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });
  await assertPending(ticket.promise);

  const ours = assistant('msg_our_reply', sessionId, { parentID: 'msg_ours' });
  api.state.messages.push(ours);
  stream.emit({ type: 'message.updated', properties: { info: ours.info } });
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });
  assert.equal((await ticket.promise).info.id, 'msg_our_reply');
  monitor.close();
});

test('fallo transitorio de read-repair SSE se contiene y recupera', async () => {
  const sessionId = 'ses_read_repair';
  const stream = fakeEventStream();
  const api = backend(sessionId);
  const logs = [];
  const monitor = createSessionTurnMonitor({
    req: api.req, eventStream: stream, sessionId, log: { debug: (line) => logs.push(line) },
  });
  const ticket = monitor.waitForTerminal({
    knownMessageIds: [], expectedParentId: 'msg_user', timeoutMs: 100, hardTimeoutMs: 500,
  });
  api.state.failMessages = true;
  stream.emit({ type: 'server.connected' });
  await delay(10);
  assert.ok(logs.some((line) => /fallo transitorio/.test(line)));
  await assertPending(ticket.promise);

  api.state.failMessages = false;
  api.state.messages = [assistant('msg_repaired', sessionId, { parentID: 'msg_user' })];
  api.state.status = {};
  stream.emit({ type: 'server.connected' });
  assert.equal((await ticket.promise).info.id, 'msg_repaired');
  monitor.close();
});

test('snapshot busy invalida un idle anterior', async () => {
  const sessionId = 'ses_idle_race';
  const stream = fakeEventStream();
  const api = backend(sessionId);
  const terminal = assistant('msg_terminal', sessionId, { parentID: 'msg_user' });
  api.state.messages = [terminal];
  api.state.status = { [sessionId]: { type: 'busy' } };
  const monitor = createSessionTurnMonitor({ req: api.req, eventStream: stream, sessionId });
  const ticket = monitor.waitForTerminal({
    knownMessageIds: [], expectedParentId: 'msg_user', timeoutMs: 100, hardTimeoutMs: 500,
  });
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });
  await assertPending(ticket.promise);
  api.state.status = {};
  stream.emit({ type: 'session.idle', properties: { sessionID: sessionId } });
  assert.equal((await ticket.promise).info.id, 'msg_terminal');
  monitor.close();
});
