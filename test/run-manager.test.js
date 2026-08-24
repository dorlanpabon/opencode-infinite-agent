const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { RunManager } = require('../dist/desktop/run-manager.js');

function input(workspace) {
  return {
    task: 'Verifica la ejecución', workspace, name: null, sessionRef: null, model: null, agent: null,
    binary: null, attach: null, maxIterations: 5, maxHours: 1, stallMinutes: 1,
    sentinel: '[TASK_COMPLETE]', todoDetection: true, autoApprove: false, autoApproveConfirmation: false,
  };
}

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
