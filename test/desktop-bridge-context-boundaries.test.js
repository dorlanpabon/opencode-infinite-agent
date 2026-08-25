const assert = require('node:assert/strict');
const { mkdtemp, readFile, readdir, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

test('bridge v5 valida limit y entrega contexto mínimo ligado al workspace', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-bridge-context-'));
  const workspace = path.join(root, 'workspace');
  const previous = process.env.OPENCODE_INFINITE_STATE_DIR;
  process.env.OPENCODE_INFINITE_STATE_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.OPENCODE_INFINITE_STATE_DIR;
    else process.env.OPENCODE_INFINITE_STATE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });

  const calls = [];
  const client = {
    session: {
      messages: async (input) => {
        calls.push(input);
        return { data: [
          { info: { role: 'user' }, parts: [{ type: 'text', text: 'viejo' }] },
          { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'reciente' }] },
          { info: { role: 'tool' }, parts: [{ type: 'text', text: 'tool-secret' }] },
          { info: { role: 'assistant', synthetic: true }, parts: [{ type: 'text', text: 'synthetic-secret' }] },
        ], response: { status: 200 } };
      },
    },
  };
  const source = pathToFileURL(path.resolve('src/desktop/plugin/opencode-infinite-bridge.mjs')).href;
  const { OpenCodeInfiniteBridge } = await import(`${source}?context-boundaries=${Date.now()}`);
  const hooks = await OpenCodeInfiniteBridge({
    client,
    directory: workspace,
    worktree: workspace,
    project: { id: 'project-context' },
  });
  t.after(() => hooks.dispose());

  const registry = path.join(root, 'bridges');
  const descriptor = JSON.parse(await readFile(path.join(registry, (await readdir(registry))[0]), 'utf8'));
  const headers = { authorization: `Bearer ${descriptor.token}` };
  const health = await fetch(`${descriptor.endpoint}/global/health`, { headers }).then((response) => response.json());
  assert.equal(health.version, 'desktop-bridge-5');

  const response = await fetch(`${descriptor.endpoint}/session/ses_Context4/message?limit=1&directory=ignored`, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ role: 'assistant', text: 'reciente' }]);
  assert.deepEqual(calls, [{
    path: { id: 'ses_Context4' },
    query: { directory: workspace, limit: 1 },
  }]);

  for (const query of ['limit=0', 'limit=21', 'limit=01', 'limit=1.5', 'limit=', 'limit=1&limit=2']) {
    const invalid = await fetch(`${descriptor.endpoint}/session/ses_Context4/message?${query}`, { headers });
    assert.equal(invalid.status, 400, query);
  }
  assert.equal((await fetch(`${descriptor.endpoint}/session/ses_Context4/message/extra`, { headers })).status, 404);
  assert.equal(calls.length, 1);
});
