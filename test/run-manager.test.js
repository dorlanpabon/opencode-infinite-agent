const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { RunManager, safeText } = require('../dist/desktop/run-manager.js');

function input(workspace) {
  return {
    task: 'Verifica la ejecución', attachments: [], workspace, name: null, sessionRef: null, model: null, agent: null,
    binary: null, attach: null, maxIterations: 5, maxHours: 1, stallMinutes: 1,
    sentinel: '[TASK_COMPLETE]', todoDetection: true, autoApprove: false, autoApproveConfirmation: false,
    resumeExisting: false,
  };
}

test('safeText elimina credenciales comunes de logs y errores', () => {
  const value = safeText('Authorization: Bearer abc.def.ghi api_key=visible sk-1234567890abcdefghijklmnop https://url-user:url-password@example.test/v1');
  assert.equal(value.includes('abc.def.ghi'), false);
  assert.equal(value.includes('visible'), false);
  assert.equal(value.includes('sk-1234567890abcdefghijklmnop'), false);
  assert.equal(value.includes('url-user'), false);
  assert.equal(value.includes('url-password'), false);
});

test('RunManager no persiste secretos reportados por el motor', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-infinite-redaction-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  const message = 'token=run-token-raw api_key=run-api-key-raw Authorization: Bearer run-auth-raw '
    + 'https://run-user:run-password@example.test/v1';
  const secrets = ['run-token-raw', 'run-api-key-raw', 'run-auth-raw', 'run-user', 'run-password'];
  const adapter = {
    doctor: async () => ({ ok: true, engineAvailable: true, workspaceReady: true, binaryReady: null,
      attachReady: null, mode: 'dedicated', serverVersion: null, endpoint: null, warnings: [] }),
    run: async (_input, context) => {
      await context.emit({ type: 'log', level: 'warn', message });
      await context.emit({ type: 'progress', iteration: 1, lastMessage: message });
      return { status: 'failed', reason: message, iteration: 1, lastMessage: message };
    },
  };
  const events = [];
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const manager = new RunManager((event) => {
    events.push(event);
    if (event.type === 'operation-finished') finish(event.run);
  }, root, adapter);
  await manager.initialize();
  const receipt = await manager.start(input(workspace));
  const final = await finished;
  const persisted = await readFile(path.join(root, 'runs', `${receipt.runId}.json`), 'utf8');
  const exposed = JSON.stringify({ events, final, persisted });
  assert.equal(final.status, 'failed');
  assert.match(exposed, /\[REDACTED\]/u);
  for (const secret of secrets) assert.equal(exposed.includes(secret), false, secret);
});

test('RunManager migra historial schema 1 sin adjuntos', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-infinite-migration-'));
  const workspace = path.join(root, 'workspace');
  const runsDirectory = path.join(root, 'runs');
  await mkdir(workspace);
  await mkdir(runsDirectory);
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = randomUUID();
  const now = new Date().toISOString();
  await writeFile(path.join(runsDirectory, `${runId}.json`), JSON.stringify({
    schemaVersion: 1,
    runId,
    operationId: randomUUID(),
    task: 'Objetivo histórico',
    workspace,
    name: 'Histórica',
    sessionRef: null,
    sessionId: null,
    model: null,
    agent: null,
    binary: null,
    attach: null,
    status: 'stopped',
    reason: 'Detenida',
    iteration: 0,
    maxIterations: 5,
    maxHours: 1,
    stallMinutes: 1,
    sentinel: '[TASK_COMPLETE]',
    todoDetection: true,
    autoApprove: false,
    sseState: 'closed',
    tokensInput: 0,
    tokensOutput: 0,
    cost: 0,
    lastMessage: null,
    lastEvent: null,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    lastError: null,
  }));
  const manager = new RunManager(() => undefined, root, null);
  await manager.initialize();
  assert.deepEqual((await manager.listRuns())[0].attachments, []);
});

test('RunManager persiste progreso y finalización del adaptador real boundary', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-infinite-manager-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [];
  const adapter = {
    doctor: async () => ({ ok: true, engineAvailable: true, workspaceReady: true, binaryReady: null,
      attachReady: null, mode: 'dedicated', serverVersion: null, endpoint: null, warnings: [] }),
    run: async (_input, context) => {
      await context.emit({ type: 'transport', state: 'connected' });
      await context.emit({ type: 'session', sessionId: 'ses_test123' });
      await context.emit({ type: 'progress', iteration: 1, tokensInput: 10, tokensOutput: 4, cost: 0.01 });
      return { status: 'completed', reason: 'Sentinel detectado', sessionId: 'ses_test123', iteration: 1 };
    },
  };
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const manager = new RunManager((event) => {
    events.push(event);
    if (event.type === 'operation-finished') finish(event.run);
  }, root, adapter);
  await manager.initialize();
  const receipt = await manager.start(input(workspace));
  const final = await finished;
  assert.equal(final.runId, receipt.runId);
  assert.equal(final.status, 'completed');
  assert.equal(final.sessionId, 'ses_test123');
  assert.equal(final.iteration, 1);
  assert.equal((await manager.listRuns())[0].status, 'completed');
  assert.ok(events.some((event) => event.type === 'run-changed'));
});

test('RunManager reserva el motor antes de persistir y rechaza concurrencia global', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-infinite-lock-'));
  const firstWorkspace = path.join(root, 'first');
  const secondWorkspace = path.join(root, 'second');
  await mkdir(firstWorkspace);
  await mkdir(secondWorkspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = {
    doctor: async () => ({ ok: true, engineAvailable: true, workspaceReady: true, binaryReady: null,
      attachReady: null, mode: 'dedicated', serverVersion: null, endpoint: null, warnings: [] }),
    run: async (_input, context) => new Promise((resolve) => {
      const stopped = () => resolve({
        status: 'stopped', reason: 'Detenida', iteration: 0,
      });
      if (context.signal.aborted) stopped();
      else context.signal.addEventListener('abort', stopped, { once: true });
    }),
  };
  const manager = new RunManager(() => undefined, root, adapter);
  await manager.initialize();
  await manager.start(input(firstWorkspace));
  await assert.rejects(
    manager.start(input(secondWorkspace)),
    (error) => error && error.code === 'ENGINE_BUSY',
  );
  await manager.shutdown();
});

test('modo continuo reserva la sesión y al apagar solo hace detach local', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-infinite-detach-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  let adapterStops = 0;
  let abortReason = null;
  const events = [];
  const adapter = {
    doctor: async () => ({ ok: true, engineAvailable: true, workspaceReady: true, binaryReady: null,
      attachReady: null, mode: 'dedicated', serverVersion: null, endpoint: null, warnings: [] }),
    listSessions: async (_input, listener) => {
      const sessions = [{
        id: 'ses_resume123', title: 'Existente', workspace, createdAt: new Date(0).toISOString(),
        updatedAt: new Date().toISOString(), status: 'busy', retryMessage: null, continuous: false, runId: null,
      }];
      listener(sessions);
      return sessions;
    },
    run: async (runInput, context) => {
      assert.equal(runInput.resumeExisting, true);
      assert.equal(runInput.sessionRef, 'ses_resume123');
      await context.emit({ type: 'session', sessionId: 'ses_resume123' });
      return new Promise((resolve) => {
        const detached = () => {
          abortReason = context.signal.reason;
          resolve({ status: 'stopped', reason: 'detached', sessionId: 'ses_resume123' });
        };
        if (context.signal.aborted) detached();
        else context.signal.addEventListener('abort', detached, { once: true });
      });
    },
    stop: async () => { adapterStops++; },
  };
  let finished;
  const done = new Promise((resolve) => { finished = resolve; });
  const manager = new RunManager((event) => {
    events.push(event);
    if (event.type === 'operation-finished') finished(event.run);
  }, root, adapter);
  await manager.initialize();
  await manager.listSessions({ workspace, binary: null, attach: null });
  const run = { ...input(workspace), sessionRef: 'ses_resume123', resumeExisting: true };
  await manager.setContinuous({ enabled: true, sessionId: 'ses_resume123', run });
  await assert.rejects(
    manager.setContinuous({ enabled: true, sessionId: 'ses_resume123', run }),
    (error) => error && error.code === 'SESSION_ALREADY_MANAGED',
  );
  await manager.setContinuous({ enabled: false, sessionId: 'ses_resume123', run: null });
  const final = await done;
  assert.equal(final.status, 'stopped');
  assert.match(final.reason, /turno actual continúa/iu);
  assert.equal(adapterStops, 0);
  assert.equal(abortReason?.code, 'RUN_PAUSED');
  assert.ok(events.some((event) => event.type === 'sessions-snapshot'
    && event.sessions.some((session) => session.id === 'ses_resume123' && session.continuous)));
  await manager.shutdown();
});

test('catálogo no cambia de servidor mientras el run global está activo', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-infinite-catalog-lock-'));
  const workspace = path.join(root, 'workspace');
  const other = path.join(root, 'other');
  await mkdir(workspace);
  await mkdir(other);
  t.after(() => rm(root, { recursive: true, force: true }));
  let catalogCalls = 0;
  const adapter = {
    doctor: async () => ({ ok: true, engineAvailable: true, workspaceReady: true, binaryReady: null,
      attachReady: null, mode: 'dedicated', serverVersion: null, endpoint: null, warnings: [] }),
    listSessions: async () => { catalogCalls++; return []; },
    run: async (_runInput, context) => new Promise((resolve) => {
      const stopped = () => resolve({ status: 'stopped', reason: 'stopped' });
      if (context.signal.aborted) stopped();
      else context.signal.addEventListener('abort', stopped, { once: true });
    }),
  };
  const manager = new RunManager(() => undefined, root, adapter);
  await manager.initialize();
  await manager.listSessions({ workspace, binary: null, attach: null });
  await manager.start(input(workspace));
  await manager.listSessions({ workspace, binary: null, attach: null });
  await assert.rejects(
    manager.listSessions({ workspace: other, binary: null, attach: null }),
    (error) => error && error.code === 'ENGINE_BUSY',
  );
  assert.equal(catalogCalls, 1);
  await manager.shutdown();
});

test('el switch solo representa leases de sesiones reanudadas', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-infinite-lease-only-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  let linked;
  const sessionLinked = new Promise((resolve) => { linked = resolve; });
  let latestSessions = [];
  const adapter = {
    doctor: async () => ({ ok: true, engineAvailable: true, workspaceReady: true, binaryReady: null,
      attachReady: null, mode: 'dedicated', serverVersion: null, endpoint: null, warnings: [] }),
    listSessions: async (_input, listener) => {
      const sessions = [{
        id: 'ses_regular123', title: 'Regular', workspace, createdAt: new Date(0).toISOString(),
        updatedAt: new Date().toISOString(), status: 'busy', retryMessage: null, continuous: false, runId: null,
      }];
      listener(sessions);
      return sessions;
    },
    run: async (_runInput, context) => {
      await context.emit({ type: 'session', sessionId: 'ses_regular123' });
      linked();
      return new Promise((resolve) => {
        const stopped = () => resolve({ status: 'stopped', reason: 'stopped', sessionId: 'ses_regular123' });
        if (context.signal.aborted) stopped();
        else context.signal.addEventListener('abort', stopped, { once: true });
      });
    },
  };
  const manager = new RunManager((event) => {
    if (event.type === 'sessions-snapshot') latestSessions = event.sessions;
  }, root, adapter);
  await manager.initialize();
  await manager.listSessions({ workspace, binary: null, attach: null });
  await manager.start(input(workspace));
  await sessionLinked;

  assert.equal(latestSessions.find((session) => session.id === 'ses_regular123')?.continuous, false);
  await assert.rejects(
    manager.setContinuous({ enabled: false, sessionId: 'ses_regular123', run: null }),
    (error) => error && error.code === 'SESSION_NOT_MANAGED',
  );
  await manager.shutdown();
});

test('detach concurrente con terminal nunca deja estado durable stopping', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-infinite-detach-race-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  let finishRun;
  let linked;
  let terminalWriteStarted;
  let releaseTerminalWrite;
  const sessionLinked = new Promise((resolve) => { linked = resolve; });
  const terminalWrite = new Promise((resolve) => { terminalWriteStarted = resolve; });
  const terminalWriteGate = new Promise((resolve) => { releaseTerminalWrite = resolve; });
  const adapter = {
    doctor: async () => ({ ok: true, engineAvailable: true, workspaceReady: true, binaryReady: null,
      attachReady: null, mode: 'dedicated', serverVersion: null, endpoint: null, warnings: [] }),
    listSessions: async (_input, listener) => {
      const sessions = [{
        id: 'ses_race123', title: 'Race', workspace, createdAt: new Date(0).toISOString(),
        updatedAt: new Date().toISOString(), status: 'busy', retryMessage: null, continuous: false, runId: null,
      }];
      listener(sessions);
      return sessions;
    },
    run: async (_runInput, context) => {
      await context.emit({ type: 'session', sessionId: 'ses_race123' });
      linked();
      return new Promise((resolve) => { finishRun = resolve; });
    },
  };
  let finished;
  const done = new Promise((resolve) => { finished = resolve; });
  const manager = new RunManager((event) => {
    if (event.type === 'operation-finished') finished(event.run);
  }, root, adapter);
  const writeState = manager.writeState.bind(manager);
  manager.writeState = async (state) => {
    if (state.status === 'completed') {
      terminalWriteStarted();
      await terminalWriteGate;
    }
    await writeState(state);
  };
  await manager.initialize();
  await manager.listSessions({ workspace, binary: null, attach: null });
  const run = { ...input(workspace), sessionRef: 'ses_race123', resumeExisting: true };
  await manager.setContinuous({ enabled: true, sessionId: 'ses_race123', run });
  await sessionLinked;

  finishRun({ status: 'completed', reason: 'done', sessionId: 'ses_race123' });
  await terminalWrite;
  const detach = manager.setContinuous({ enabled: false, sessionId: 'ses_race123', run: null });
  releaseTerminalWrite();
  await detach;
  const final = await done;

  assert.equal(final.status, 'completed');
  assert.equal((await manager.getRun(final.runId)).status, 'completed');
  await manager.shutdown();
});
