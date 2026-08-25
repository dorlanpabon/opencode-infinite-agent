const assert = require('node:assert/strict');
const { mkdtemp, readdir, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

test('plugin Desktop expone solo la API autenticada necesaria del SDK propietario', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-bridge-plugin-'));
  const previous = process.env.OPENCODE_INFINITE_STATE_DIR;
  process.env.OPENCODE_INFINITE_STATE_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.OPENCODE_INFINITE_STATE_DIR;
    else process.env.OPENCODE_INFINITE_STATE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });

  const workspace = path.join(root, 'workspace');
  const calls = [];
  const ok = (data) => ({ data, response: { status: 200 } });
  const client = {
    _client: {
      async get(options) {
        if (options.url === '/provider') {
          calls.push(['providers', options]);
          return ok({
            all: [{
              id: 'openai', name: 'OpenAI', models: {
                'gpt-5.4': { id: 'gpt-5.4', name: 'GPT-5.4' },
                legacy: { id: 'legacy', name: 'Legacy', status: 'deprecated' },
              },
            }],
            connected: ['openai'],
            default: { openai: 'gpt-5.4' },
          });
        }
        if (options.url === '/config') {
          calls.push(['config', options]);
          return ok({ model: null, provider: { openai: { options: { apiKey: 'must-not-cross-bridge' } } } });
        }
        calls.push(['globalList', options]);
        if (options.query.cursor === undefined) {
          return {
            data: [{ id: 'ses_global1', directory: path.join(root, 'other') }],
            response: { status: 200, headers: new Headers({ 'x-next-cursor': '10' }) },
          };
        }
        return {
          data: [{ id: 'ses_real1', directory: workspace }],
          response: { status: 200, headers: new Headers() },
        };
      },
    },
    session: {
      list: async (options) => { calls.push(['list', options]); return ok([{ id: 'ses_real1' }]); },
      status: async (options) => { calls.push(['status', options]); return ok({ ses_real1: { type: 'busy' } }); },
      get: async (options) => {
        calls.push(['get', options]);
        if (options.path.id === 'ses_configinvalid') {
          return {
            error: {
              name: 'ConfigInvalidError',
              data: {
                path: path.join(workspace, 'opencode.jsonc'),
                issues: [{ path: ['agent', 'reviewer', 'mode'], message: 'Expected subagent, got read-only' }],
              },
            },
            response: { status: 400 },
          };
        }
        return ok({ id: options.path.id, directory: workspace });
      },
      messages: async (options) => {
        calls.push(['messages', options]);
        return ok([
          ...Array.from({ length: 7 }, (_, index) => ({
            info: { role: index % 2 === 0 ? 'user' : 'assistant' },
            parts: [{ type: 'text', text: String(index).repeat(5_000) }],
          })),
          { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'hidden', synthetic: true }] },
          { info: { role: 'tool' }, parts: [{ type: 'text', text: 'tool-secret' }] },
        ]);
      },
      todo: async (options) => { calls.push(['todo', options]); return ok([{ id: 'todo_real1', status: 'completed' }]); },
      promptAsync: async (options) => { calls.push(['promptAsync', options]); return { data: {}, response: { status: 204 } }; },
      abort: async (options) => { calls.push(['abort', options]); return ok(true); },
    },
  };
  const source = pathToFileURL(path.resolve('src/desktop/plugin/opencode-infinite-bridge.mjs')).href;
  const { OpenCodeInfiniteBridge } = await import(`${source}?test=${Date.now()}`);
  const hooks = await OpenCodeInfiniteBridge({
    client,
    directory: workspace,
    worktree: workspace,
    project: { id: 'project-real' },
  });
  const registryDirectory = path.join(root, 'bridges');
  const files = await readdir(registryDirectory);
  const descriptorFile = path.join(registryDirectory, files[0]);
  const descriptor = JSON.parse(await readFile(descriptorFile, 'utf8'));
  const headers = { authorization: `Bearer ${descriptor.token}` };
  assert.equal((await fetch(`${descriptor.endpoint}/global/health`)).status, 401);
  const health = await fetch(`${descriptor.endpoint}/global/health`, { headers }).then((response) => response.json());
  assert.equal(health.buildId, descriptor.buildId);
  assert.match(health.buildId, /^[a-f0-9]{64}$/u);
  const sessions = await fetch(`${descriptor.endpoint}/session?directory=${encodeURIComponent(workspace)}`, { headers });
  assert.deepEqual(await sessions.json(), [
    { id: 'ses_global1', directory: path.join(root, 'other') },
    { id: 'ses_real1', directory: workspace },
  ]);
  assert.equal(calls.filter(([name]) => name === 'globalList').length, 2);
  assert.equal(calls.some(([name]) => name === 'list'), false);

  const models = await fetch(`${descriptor.endpoint}/models?directory=${encodeURIComponent(workspace)}`, { headers })
    .then((response) => response.json());
  assert.deepEqual(models, {
    models: [{
      id: 'openai/gpt-5.4',
      providerId: 'openai',
      providerName: 'OpenAI',
      modelId: 'gpt-5.4',
      name: 'GPT-5.4',
      providerDefault: true,
    }],
    configuredModel: null,
  });
  assert.equal(JSON.stringify(models).includes('must-not-cross-bridge'), false);
  assert.equal(calls.find(([name]) => name === 'providers')[1].query.directory, workspace);

  const objective = 'x'.repeat(100_000);
  const prompt = await fetch(`${descriptor.endpoint}/session/ses_real1/prompt_async`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text: objective }] }),
  });
  assert.equal(prompt.status, 204);
  assert.equal(calls.find(([name]) => name === 'promptAsync')[1].body.parts[0].text.length, objective.length);
  const todos = await fetch(`${descriptor.endpoint}/session/ses_real1/todo`, { headers });
  assert.deepEqual(await todos.json(), [{ id: 'todo_real1', status: 'completed' }]);
  const context = await fetch(`${descriptor.endpoint}/session/ses_real1/message?limit=20`, { headers });
  const contextBody = await context.json();
  assert.equal(contextBody.length, 6);
  assert.equal(contextBody.every((message) => ['user', 'assistant'].includes(message.role) && message.text.length === 4_000), true);
  assert.equal(JSON.stringify(contextBody).includes('hidden'), false);
  assert.equal(JSON.stringify(contextBody).includes('tool-secret'), false);
  assert.equal(contextBody.reduce((total, message) => total + message.text.length, 0), 24_000);
  assert.equal(calls.findLast(([name]) => name === 'messages')[1].query.limit, 20);
  assert.equal((await fetch(`${descriptor.endpoint}/session/ses_real1/message?limit=21`, { headers })).status, 400);
  const invalid = await fetch(`${descriptor.endpoint}/session/ses_configinvalid`, { headers });
  assert.equal(invalid.status, 400);
  const invalidBody = await invalid.json();
  assert.match(invalidBody.error, /opencode\.jsonc.*agent\.reviewer\.mode.*subagent.*read-only/iu);
  assert.equal(typeof hooks.event, 'function');
  assert.equal(typeof hooks.dispose, 'function');
  assert.equal(Object.hasOwn(hooks, 'permission.ask'), false);
  await hooks.dispose();
  assert.deepEqual(await readdir(registryDirectory), []);
  await assert.rejects(fetch(`${descriptor.endpoint}/global/health`, { headers }));
});

test('un error transitorio del catálogo global no desactiva su siguiente reintento', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-bridge-global-retry-'));
  const previous = process.env.OPENCODE_INFINITE_STATE_DIR;
  process.env.OPENCODE_INFINITE_STATE_DIR = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.OPENCODE_INFINITE_STATE_DIR;
    else process.env.OPENCODE_INFINITE_STATE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });

  const workspace = path.join(root, 'workspace');
  let globalCalls = 0;
  let projectCalls = 0;
  const client = {
    _client: {
      async get() {
        globalCalls += 1;
        if (globalCalls === 1) {
          return { error: { message: 'temporal' }, response: { status: 503, headers: new Headers() } };
        }
        return {
          data: [{ id: 'ses_recovered1', directory: workspace }],
          response: { status: 200, headers: new Headers() },
        };
      },
    },
    session: {
      list: async () => { projectCalls += 1; return { data: [] }; },
      status: async () => ({ data: {} }),
    },
  };
  const source = pathToFileURL(path.resolve('src/desktop/plugin/opencode-infinite-bridge.mjs')).href;
  const { OpenCodeInfiniteBridge } = await import(`${source}?retry=${Date.now()}`);
  const hooks = await OpenCodeInfiniteBridge({
    client,
    directory: workspace,
    worktree: workspace,
    project: { id: 'project-retry' },
  });
  t.after(() => hooks.dispose());
  const registryDirectory = path.join(root, 'bridges');
  const files = await readdir(registryDirectory);
  const descriptor = JSON.parse(await readFile(path.join(registryDirectory, files[0]), 'utf8'));
  const headers = { authorization: `Bearer ${descriptor.token}` };

  const failed = await fetch(`${descriptor.endpoint}/session`, { headers });
  assert.equal(failed.status, 503);
  const recovered = await fetch(`${descriptor.endpoint}/session`, { headers });
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), [{ id: 'ses_recovered1', directory: workspace }]);
  assert.equal(globalCalls, 2);
  assert.equal(projectCalls, 0);
});
