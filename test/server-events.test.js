const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  authHeaders,
  isolatedConfigDir,
  parseSseFrames,
  removeIsolatedConfigDir,
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
      if (args[2] === '/permission/per_fallback/reply') throw new Error('404');
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
