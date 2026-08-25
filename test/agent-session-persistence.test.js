const assert = require('node:assert/strict');
const test = require('node:test');

test('executeAgent espera que sessionId quede durable antes de iniciar el loop', async (t) => {
  const server = require('../src/server');
  const session = require('../src/session');
  const loop = require('../src/loop');
  const agentPath = require.resolve('../src/agent');
  const originals = {
    ensureServer: server.ensureServer,
    startEventStream: server.startEventStream,
    resolveSession: session.resolveSession,
    runLoop: loop.runLoop,
  };
  t.after(() => {
    Object.assign(server, {
      ensureServer: originals.ensureServer,
      startEventStream: originals.startEventStream,
    });
    session.resolveSession = originals.resolveSession;
    loop.runLoop = originals.runLoop;
    delete require.cache[agentPath];
  });

  server.ensureServer = async () => ({ base: 'http://127.0.0.1:4567', owned: false });
  server.startEventStream = () => ({ ready: Promise.resolve(), abort() {} });
  session.resolveSession = async () => ({ created: false, session: { id: 'ses_persist_gate' } });
  let loopCalls = 0;
  loop.runLoop = async () => {
    loopCalls += 1;
    return {
      status: 'complete',
      reason: 'done',
      state: { iterations: 1, tokens: { input: 0, output: 0 }, cost: 0, lastText: '' },
    };
  };
  delete require.cache[agentPath];
  const { executeAgent } = require('../src/agent');

  let releasePersistence;
  let sessionObserved;
  const observed = new Promise((resolve) => { sessionObserved = resolve; });
  const persistence = new Promise((resolve) => { releasePersistence = resolve; });
  const run = executeAgent({
    dir: process.cwd(),
    attach: 'http://127.0.0.1:4567',
    prompt: 'objetivo durable',
    maxIterations: 1,
  }, {
    onSession: () => {
      sessionObserved();
      return persistence;
    },
  });

  await observed;
  await Promise.resolve();
  assert.equal(loopCalls, 0);
  releasePersistence();
  assert.equal((await run).status, 'complete');
  assert.equal(loopCalls, 1);
});
