const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  authHeaders,
  isolatedConfigDir,
  parseSseFrames,
  request,
  removeIsolatedConfigDir,
  startEventStream,
  startPermissionApprover,
} = require('../src/server');

function fakeEventStream() {
  const listeners = new Set();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async emit(event) {
      await Promise.all([...listeners].map((listener) => listener(event)));
    },
  };
}

async function waitFor(predicate, timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('waitFor timeout');
}

function stalledSseBody(onCancel) {
  let finishRead = null;
  return {
    getReader() {
      return {
        read() {
          return new Promise((resolve) => { finishRead = resolve; });
        },
        cancel() {
          onCancel();
          if (finishRead) finishRead({ done: true, value: undefined });
          return Promise.resolve();
        },
        releaseLock() {},
      };
    },
  };
}

test('config aislada usa directorios privados unicos y limpieza acotada', () => {
  const first = isolatedConfigDir();
  const second = isolatedConfigDir();
  try {
    assert.notEqual(first, second);
    assert.equal(path.dirname(first), os.tmpdir());
    assert.equal(fs.readFileSync(path.join(first, 'opencode', 'opencode.json'), 'utf8'), '{}\n');
    removeIsolatedConfigDir(first);
    assert.equal(fs.existsSync(first), false);
    removeIsolatedConfigDir(os.tmpdir());
    assert.equal(fs.existsSync(os.tmpdir()), true);
  } finally {
    removeIsolatedConfigDir(first);
    removeIsolatedConfigDir(second);
  }
});

test('parser SSE conserva frames parciales y desenvuelve payload', () => {
  const events = [];
  let rest = parseSseFrames(
    'data: {"type":"server.connected","properties":{}}\n\n' +
    'data: {"payload":{"type":"session.',
    (event) => events.push(event)
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'server.connected');

  rest = parseSseFrames(rest + 'idle","properties":{"sessionID":"ses_x"}}}\r\n\r\n', (event) => events.push(event));
  assert.equal(rest, '');
  assert.equal(events.length, 2);
  assert.equal(events[1].type, 'session.idle');
  assert.equal(events[1].properties.sessionID, 'ses_x');
});

test('request enruta el workspace como el SDK oficial', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const directory = 'D:\\proyectos\\área segura';
  await request('http://127.0.0.1:4096', 'GET', '/session/status?limit=1', null, {
    directory, fetchImpl,
  });
  await request('http://127.0.0.1:4096', 'POST', '/session', { title: 'x' }, {
    directory, fetchImpl,
  });

  const getUrl = new URL(calls[0].url);
  assert.equal(getUrl.searchParams.get('directory'), directory);
  assert.equal(getUrl.searchParams.get('limit'), '1');
  assert.equal(calls[0].options.headers['x-opencode-directory'], undefined);
  const postUrl = new URL(calls[1].url);
  assert.equal(postUrl.searchParams.has('directory'), false);
  assert.equal(calls[1].options.headers['x-opencode-directory'], encodeURIComponent(directory));
});

test('SSE vence una conexion muda, cancela el lector y reconecta con workspace', async () => {
  const calls = [];
  let cancels = 0;
  const stream = startEventStream({
    base: 'http://127.0.0.1:4096',
    directory: 'D:\\workspace con espacio',
    heartbeatTimeoutMs: 15,
    reconnectMinMs: 1,
    reconnectMaxMs: 2,
    fetchImpl: async (url, options) => {
      calls.push({ url, signal: options.signal });
      return { ok: true, status: 200, body: stalledSseBody(() => { cancels++; }) };
    },
  });
  await stream.ready;
  await waitFor(() => calls.length >= 2, 300);
  assert.ok(cancels >= 1);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(new URL(calls[0].url).searchParams.get('directory'), 'D:\\workspace con espacio');
  stream.abort();
  await stream.done;
});

test('SSE abortado antes de conectar cierra ready y done limpiamente', async () => {
  const ctl = new AbortController();
  ctl.abort();
  const stream = startEventStream({
    base: 'http://127.0.0.1:4096',
    signal: ctl.signal,
    fetchImpl: async () => { throw new Error('no debe conectar'); },
  });
  await assert.rejects(stream.ready, /SSE abortado/u);
  await stream.done;
});

test('auth Basic exige origen y rechaza HTTP remoto', () => {
  const previousPassword = process.env.OPENCODE_SERVER_PASSWORD;
  const previousUsername = process.env.OPENCODE_SERVER_USERNAME;
  process.env.OPENCODE_SERVER_PASSWORD = 'test-only-password';
  process.env.OPENCODE_SERVER_USERNAME = 'tester';
  try {
    assert.throws(() => authHeaders(), /requiere el origen/);
    assert.throws(() => authHeaders('http://example.com:4096'), /Se rechazo enviar/);
    assert.match(authHeaders('http://127.0.0.1:4096').Authorization, /^Basic /);
    assert.throws(() => authHeaders('https://example.com'), /fuera de loopback/);
  } finally {
    if (previousPassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
    else process.env.OPENCODE_SERVER_PASSWORD = previousPassword;
    if (previousUsername === undefined) delete process.env.OPENCODE_SERVER_USERNAME;
    else process.env.OPENCODE_SERVER_USERNAME = previousUsername;
  }
});

test('auto-approve filtra exactamente permission.asked y sessionID', async () => {
  const stream = fakeEventStream();
  const calls = [];
  const sent = [];
  const approver = startPermissionApprover({
    base: 'http://127.0.0.1:1',
    eventStream: stream,
    sessionId: 'ses_target',
    requestFn: async (...args) => { calls.push(args); return args[1] === 'GET' ? [] : true; },
    onResponseSent: (...args) => sent.push(args),
  });

  await stream.emit({ type: 'permission.updated', properties: { sessionID: 'ses_target', id: 'per_old' } });
  await stream.emit({ type: 'permission.v2.asked', properties: { sessionID: 'ses_target', id: 'per_v2' } });
  await stream.emit({ type: 'permission.asked', properties: { sessionID: 'ses_other', id: 'per_other' } });
  await stream.emit({ type: 'permission.asked', properties: { id: 'per_missing_session' } });
  assert.equal(calls.filter((call) => call[1] === 'POST').length, 0);

  const event = {
    type: 'permission.asked',
    properties: { sessionID: 'ses_target', id: 'per_exact', permission: 'bash' },
  };
  await stream.emit(event);
  await stream.emit(event);

  await waitFor(() => calls.filter((call) => call[1] === 'POST').length === 1);
  const posts = calls.filter((call) => call[1] === 'POST');
  assert.deepEqual(posts[0].slice(1, 4), [
    'POST',
    '/permission/per_exact/reply',
    { reply: 'once' },
  ]);
  assert.deepEqual(sent[0], ['ses_target', 'per_exact', 'bash', 'nuevo']);
  approver.abort();
});

test('auto-approve usa fallback legado con los mismos IDs exactos', async () => {
  const stream = fakeEventStream();
  const calls = [];
  const approver = startPermissionApprover({
    base: 'http://127.0.0.1:1',
    eventStream: stream,
    sessionId: 'ses_target',
    requestFn: async (...args) => {
      calls.push(args);
      if (args[1] === 'GET') return [];
      if (args[2] === '/permission/per_fallback/reply') {
        const error = new Error('404');
        error.status = 404;
        throw error;
      }
      return true;
    },
  });

  await stream.emit({
    type: 'permission.asked',
    properties: { sessionID: 'ses_target', requestID: 'per_fallback', permission: 'edit' },
  });

  await waitFor(() => calls.filter((call) => call[1] === 'POST').length === 2);
  const posts = calls.filter((call) => call[1] === 'POST');
  assert.deepEqual(posts[1].slice(1, 4), [
    'POST',
    '/session/ses_target/permissions/per_fallback',
    { response: 'once' },
  ]);
  approver.abort();
});

test('auto-approve reconcilia permisos pendientes de la sesion al conectar', async () => {
  const stream = fakeEventStream();
  const calls = [];
  const approver = startPermissionApprover({
    base: 'http://127.0.0.1:1',
    eventStream: stream,
    sessionId: 'ses_target',
    requestFn: async (...args) => {
      calls.push(args);
      if (args[1] === 'GET') return [
        { sessionID: 'ses_other', id: 'per_other' },
        { sessionID: 'ses_target', id: 'per_pending', permission: 'bash' },
      ];
      return true;
    },
  });
  await waitFor(() => calls.some((call) => call[2] === '/permission/per_pending/reply'));
  assert.equal(calls.some((call) => call[2] === '/permission/per_other/reply'), false);
  approver.abort();
});

test('auto-approve reconcilia antes de reintentar una respuesta ambigua', async () => {
  const stream = fakeEventStream();
  const calls = [];
  const sent = [];
  const payload = { sessionID: 'ses_target', id: 'per_retry', permission: 'bash' };
  let pending = false;
  let postAttempts = 0;
  const approver = startPermissionApprover({
    base: 'http://127.0.0.1:1',
    directory: 'D:\\workspace',
    eventStream: stream,
    sessionId: 'ses_target',
    retryMinMs: 5,
    retryMaxMs: 10,
    requestFn: async (...args) => {
      calls.push(args);
      if (args[1] === 'GET') return pending ? [payload] : [];
      postAttempts++;
      if (postAttempts === 1) throw new Error('ECONNRESET despues de enviar');
      pending = false;
      return true;
    },
    onResponseSent: (...args) => sent.push(args),
  });
  await waitFor(() => calls.some((call) => call[1] === 'GET'));
  pending = true;
  await stream.emit({ type: 'permission.asked', properties: payload });
  await waitFor(() => sent.length === 1, 400);
  await stream.emit({ type: 'permission.asked', properties: payload });
  await stream.emit({ type: 'server.connected' });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const modernPosts = calls.filter((call) => call[1] === 'POST' && call[2] === '/permission/per_retry/reply');
  assert.equal(modernPosts.length, 2);
  assert.equal(calls.some((call) => call[2] === '/session/ses_target/permissions/per_retry'), false);
  assert.equal(sent.length, 1);
  assert.ok(calls.every((call) => call[4].directory === 'D:\\workspace'));
  assert.ok(calls.every((call) => call[4].signal instanceof AbortSignal));
  approver.abort();
});

test('auto-approve no repite un POST ambiguo si el permiso ya desaparecio', async () => {
  const stream = fakeEventStream();
  const calls = [];
  const payload = { sessionID: 'ses_target', id: 'per_applied', permission: 'bash' };
  const approver = startPermissionApprover({
    base: 'http://127.0.0.1:1',
    eventStream: stream,
    sessionId: 'ses_target',
    retryMinMs: 5,
    retryMaxMs: 10,
    requestFn: async (...args) => {
      calls.push(args);
      if (args[1] === 'GET') return [];
      throw new Error('respuesta perdida despues de aplicar');
    },
  });
  await waitFor(() => calls.some((call) => call[1] === 'GET'));
  await stream.emit({ type: 'permission.asked', properties: payload });
  await waitFor(() => calls.filter((call) => call[1] === 'GET').length >= 2, 400);
  await stream.emit({ type: 'permission.asked', properties: payload });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.filter((call) => call[1] === 'POST').length, 1);
  approver.abort();
});

test('auto-approve aborta requests en vuelo y no aprueba despues de detener', async () => {
  const stream = fakeEventStream();
  const sent = [];
  let postSignal = null;
  let aborted = false;
  const approver = startPermissionApprover({
    base: 'http://127.0.0.1:1',
    eventStream: stream,
    sessionId: 'ses_target',
    retryMinMs: 5,
    requestFn: async (_base, method, _path, _body, options) => {
      if (method === 'GET') return [];
      postSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          aborted = true;
          const error = new Error('abortado');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
    onResponseSent: (...args) => sent.push(args),
  });
  await stream.emit({
    type: 'permission.asked',
    properties: { sessionID: 'ses_target', id: 'per_stop', permission: 'bash' },
  });
  await waitFor(() => postSignal !== null);
  approver.abort();
  await waitFor(() => aborted);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(postSignal.aborted, true);
  assert.equal(sent.length, 0);
});
