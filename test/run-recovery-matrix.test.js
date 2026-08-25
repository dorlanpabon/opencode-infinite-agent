const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { RunManager } = require('../dist/desktop/run-manager.js');

function historicalRun({ runId, workspace, sessionRef = null, attach = null, status = 'failed' }) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    runId,
    operationId: randomUUID(),
    task: 'Recupera el trabajo pendiente',
    workspace,
    name: 'Histórica',
    sessionRef,
    sessionId: null,
    model: null,
    agent: null,
    binary: null,
    attach,
    status,
    reason: 'Interrumpida',
    iteration: 1,
    maxIterations: 5,
    maxHours: 1,
    stallMinutes: 1,
    sentinel: '[TASK_COMPLETE]',
    todoDetection: true,
    autoApprove: true,
    sseState: 'closed',
    tokensInput: 0,
    tokensOutput: 0,
    cost: 0,
    lastMessage: null,
    lastEvent: null,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    lastError: 'Interrumpida',
  };
}

test('schema 1 migra dedicated, attach y referencias oc:// a modos exactos', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-recovery-migration-'));
  const workspace = path.join(root, 'workspace');
  const runs = path.join(root, 'runs');
  await mkdir(workspace);
  await mkdir(runs);
  t.after(() => rm(root, { recursive: true, force: true }));

  const fixtures = [
    { runId: randomUUID(), expected: 'dedicated' },
    {
      runId: randomUUID(),
      sessionRef: 'oc://renderer/server/c2lkZWNhcg/session/ses_Historical1',
      expected: 'dedicated',
    },
    { runId: randomUUID(), attach: 'http://127.0.0.1:4096', expected: 'attach' },
  ];
  await Promise.all(fixtures.map((fixture) => writeFile(
    path.join(runs, `${fixture.runId}.json`),
    JSON.stringify(historicalRun({ ...fixture, workspace })),
  )));

  const manager = new RunManager(() => undefined, root, null);
  await manager.initialize();
  for (const fixture of fixtures) {
    const migrated = await manager.getRun(fixture.runId);
    assert.equal(migrated.schemaVersion, 3);
    assert.equal(migrated.sourceRunId, null);
    assert.equal(migrated.firstPromptMarker, null);
    assert.equal(migrated.firstPromptKind, null);
    assert.equal(migrated.connectionMode, fixture.expected);
  }
});

test('fallo Desktop sin sesión exacta se reintenta como sucesora dedicated y sin autoaprobación', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-recovery-fallback-'));
  const workspace = path.join(root, 'workspace');
  const runs = path.join(root, 'runs');
  await mkdir(workspace);
  await mkdir(runs);
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourceRunId = randomUUID();
  await writeFile(path.join(runs, `${sourceRunId}.json`), JSON.stringify({
    ...historicalRun({ runId: sourceRunId, workspace, status: 'failed' }),
    schemaVersion: 2,
    attachments: [],
    sourceRunId: null,
    connectionMode: 'desktop-sidecar',
  }));

  let received;
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const manager = new RunManager((event) => {
    if (event.type === 'operation-finished') finish(event.run);
  }, root, {
    doctor: async () => ({ ok: true, engineAvailable: true, workspaceReady: true, binaryReady: null,
      attachReady: null, mode: 'dedicated', serverVersion: null, endpoint: null, warnings: [] }),
    run: async (input) => {
      received = input;
      return { status: 'completed', reason: 'Listo' };
    },
  });
  await manager.initialize();
  const receipt = await manager.resume({ runId: sourceRunId, confirmed: true });
  const successor = await finished;

  assert.equal(successor.runId, receipt.runId);
  assert.equal(successor.sourceRunId, sourceRunId);
  assert.equal(successor.connectionMode, 'dedicated');
  assert.equal(received.connectionMode, 'dedicated');
  assert.equal(received.sessionRef, null);
  assert.equal(received.resumeExisting, false);
  assert.equal(received.recoveryMode, 'new-objective');
  assert.equal(received.firstPromptKind, 'objective');
  assert.equal(received.autoApprove, false);
  assert.equal(received.autoApproveConfirmation, false);
});

test('corrida detenida reanuda la misma sesión exacta como una sucesora', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-recovery-stopped-'));
  const workspace = path.join(root, 'workspace');
  const runs = path.join(root, 'runs');
  await mkdir(workspace);
  await mkdir(runs);
  t.after(() => rm(root, { recursive: true, force: true }));

  const sourceRunId = randomUUID();
  await writeFile(path.join(runs, `${sourceRunId}.json`), JSON.stringify({
    ...historicalRun({ runId: sourceRunId, workspace, status: 'stopped' }),
    schemaVersion: 2,
    attachments: [],
    sourceRunId: null,
    sessionId: 'ses_Stopped1',
    connectionMode: 'dedicated',
  }));

  let received;
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const manager = new RunManager((event) => {
    if (event.type === 'operation-finished') finish(event.run);
  }, root, {
    doctor: async () => ({ ok: true, engineAvailable: true, workspaceReady: true, binaryReady: null,
      attachReady: null, mode: 'dedicated', serverVersion: null, endpoint: null, warnings: [] }),
    run: async (input) => {
      received = input;
      return { status: 'completed', reason: 'Listo', sessionId: 'ses_Stopped1' };
    },
  });
  await manager.initialize();
  const receipt = await manager.resume({ runId: sourceRunId, confirmed: true });
  const successor = await finished;

  assert.equal(successor.runId, receipt.runId);
  assert.equal(successor.sourceRunId, sourceRunId);
  assert.equal(received.sessionRef, 'ses_Stopped1');
  assert.equal(received.resumeExisting, true);
  assert.equal(received.recoveryMode, 'continue');
  assert.equal(received.firstPromptKind, 'continuation');
  assert.equal(received.autoApprove, false);
});

test('una corrida completada nunca se puede reanudar', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-recovery-completed-'));
  const workspace = path.join(root, 'workspace');
  const runs = path.join(root, 'runs');
  await mkdir(workspace);
  await mkdir(runs);
  t.after(() => rm(root, { recursive: true, force: true }));
  const runId = randomUUID();
  await writeFile(path.join(runs, `${runId}.json`), JSON.stringify({
    ...historicalRun({ runId, workspace, status: 'completed' }),
    schemaVersion: 2,
    attachments: [],
    sourceRunId: null,
    connectionMode: 'dedicated',
  }));
  const manager = new RunManager(() => undefined, root, {
    doctor: async () => { throw new Error('no debe ejecutarse'); },
    run: async () => { throw new Error('no debe ejecutarse'); },
  });
  await manager.initialize();
  await assert.rejects(
    manager.resume({ runId, confirmed: true }),
    (error) => error?.code === 'RUN_NOT_RESUMABLE',
  );
});
