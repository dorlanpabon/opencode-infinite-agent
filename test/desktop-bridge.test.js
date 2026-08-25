const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { access, mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { OpenCodeDesktopBridgeCatalog } = require('../dist/desktop/desktop-bridge.js');

function stream() {
  const listeners = new Set();
  return {
    ready: Promise.resolve(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    abort() {
      listeners.clear();
    },
    emit(event) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-desktop-bridge-'));
  const registry = path.join(root, 'bridges');
  const pluginSource = path.join(root, 'source.mjs');
  const pluginDestination = path.join(root, 'config', 'opencode-infinite-bridge.js');
  const workspace = path.join(root, 'workspace');
  const otherWorkspace = path.join(root, 'other-workspace');
  const pluginSourceText = '// opencode-infinite-agent:desktop-bridge\nexport const OpenCodeInfiniteBridge = async () => ({});\n';
  await Promise.all([
    mkdir(registry, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(otherWorkspace, { recursive: true }),
    writeFile(pluginSource, pluginSourceText),
  ]);
  const descriptor = {
    schemaVersion: 1,
    bridgeVersion: 3,
    buildId: createHash('sha256').update(pluginSourceText).digest('hex'),
    bridgeId: 'a'.repeat(32),
    endpoint: 'http://127.0.0.1:43111',
    token: 'b'.repeat(64),
    pid: 1234,
    projectID: 'project-1',
    directory: workspace,
    worktree: workspace,
    startedAt: new Date().toISOString(),
  };
  const eventStream = stream();
  const calls = [];
  const auth = new Map();
  const known = new Map([[descriptor.endpoint, descriptor]]);
  const server = {
    registerDesktopBridge(base, token) { auth.set(base, token); calls.push({ type: 'register', base, token }); },
    unregisterDesktopBridge(base) { auth.delete(base); calls.push({ type: 'unregister', base }); },
    startEventStream() { return eventStream; },
    async request(base, method, pathname, body, options) {
      calls.push({ type: 'request', base, method, pathname, body, options });
      if (pathname === '/global/health') {
        const target = known.get(base);
        if (!target || auth.get(base) !== target.token) throw new Error('401');
        return { healthy: true, bridgeId: target.bridgeId, buildId: target.buildId };
      }
      if (pathname === '/session') {
        return [
          { id: 'ses_visible1', title: 'Visible', directory: workspace, projectID: descriptor.projectID, time: { created: 1, updated: 2 } },
          { id: 'ses_mixed1', title: 'Otro workspace', directory: otherWorkspace, projectID: descriptor.projectID, time: { created: 1, updated: 3 } },
        ];
      }
      if (pathname === '/session/status') return { ses_visible1: { type: 'busy' } };
      if (pathname === '/session/ses_adopted1') {
        return { id: 'ses_adopted1', title: 'Adoptada', directory: workspace, projectID: descriptor.projectID, time: { created: 3, updated: 4 } };
      }
      if (pathname === '/session/ses_wrong1') {
        return { id: 'ses_wrong1', title: 'Directa ajena', directory: otherWorkspace, projectID: 'other', time: { created: 3, updated: 4 } };
      }
      throw new Error(`unexpected ${method} ${pathname}`);
    },
  };
  const dependencies = {
    server,
    registryDirectory: () => registry,
    pluginSource,
    pluginDestination,
    connectTimeoutMs: 1_000,
    processExists: () => true,
  };
  return { auth, calls, dependencies, descriptor, eventStream, known, otherWorkspace, pluginDestination, pluginSourceText, registry, root, workspace };
}

test('catálogo Desktop agrega sesiones globales y adopta un oc:// exacto con su workspace real', async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await writeFile(path.join(fx.registry, 'bridge.json'), JSON.stringify(fx.descriptor));
  await writeFile(path.join(fx.registry, 'stale-same-port.json'), JSON.stringify({
    ...fx.descriptor,
    bridgeId: 'c'.repeat(32),
    token: 'd'.repeat(64),
    startedAt: new Date(Date.now() + 1_000).toISOString(),
  }));
  const catalog = new OpenCodeDesktopBridgeCatalog(() => undefined, fx.dependencies);
  t.after(() => catalog.close());

  const result = await catalog.connect({
    workspace: fx.workspace,
    binary: null,
    attach: null,
    sessionRef: 'oc://renderer/server/c2lkZWNhcg/session/ses_adopted1',
  });

  assert.deepEqual(result.sessions.map((session) => session.id), ['ses_adopted1', 'ses_mixed1', 'ses_visible1']);
  assert.equal(result.sessions.find((session) => session.id === 'ses_visible1').status, 'busy');
  assert.equal(catalog.endpointForSession('ses_adopted1').endpoint, fx.descriptor.endpoint);
  assert.equal(catalog.endpointForSession('ses_mixed1').directory, fx.otherWorkspace);
  assert.equal(fx.calls.filter((call) => call.type === 'register').at(-1).token, fx.descriptor.token);
});

test('conexiones iguales se comparten y un SSE que no abre falla con tiempo acotado', async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await writeFile(path.join(fx.registry, 'bridge.json'), JSON.stringify(fx.descriptor));
  const input = { workspace: fx.workspace, binary: null, attach: null, sessionRef: null };
  const catalog = new OpenCodeDesktopBridgeCatalog(() => undefined, fx.dependencies);
  t.after(() => catalog.close());

  const [first, second] = await Promise.all([catalog.connect(input), catalog.connect(input)]);
  assert.deepEqual(first.sessions, second.sessions);
  assert.equal(fx.calls.filter((call) => call.pathname === '/global/health').length, 1);
  await catalog.close();

  let aborted = false;
  const blocked = new OpenCodeDesktopBridgeCatalog(() => undefined, {
    ...fx.dependencies,
    connectTimeoutMs: 20,
    server: {
      ...fx.dependencies.server,
      startEventStream() {
        return {
          ready: new Promise(() => undefined),
          subscribe() { return () => undefined; },
          abort() { aborted = true; },
        };
      },
    },
  });
  t.after(() => blocked.close());
  await assert.rejects(blocked.connect(input), /no abrió el stream.*a tiempo/iu);
  assert.equal(aborted, true);
});

test('adopción rechaza una sesión exacta si el bridge no pertenece a su proyecto', async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await writeFile(path.join(fx.registry, 'bridge.json'), JSON.stringify(fx.descriptor));
  const catalog = new OpenCodeDesktopBridgeCatalog(() => undefined, fx.dependencies);
  t.after(() => catalog.close());

  const result = await catalog.connect({
    workspace: fx.workspace,
    binary: null,
    attach: null,
    sessionRef: 'ses_wrong1',
  });
  assert.equal(result.sessions.some((session) => session.id === 'ses_wrong1'), false);
  assert.throws(() => catalog.endpointForSession('ses_wrong1'), /no está disponible/iu);
});

test('si no hay bridge instala el plugin global sin sobrescribir archivos ajenos', async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  const catalog = new OpenCodeDesktopBridgeCatalog(() => undefined, fx.dependencies);
  t.after(() => catalog.close());
  const input = { workspace: fx.workspace, binary: null, attach: null, sessionRef: null };

  await assert.rejects(catalog.connect(input), /Integración instalada.*vuelve a abrir OpenCode Desktop/iu);
  assert.match(await readFile(fx.pluginDestination, 'utf8'), /OpenCodeInfiniteBridge/u);

  await writeFile(fx.pluginDestination, '// mentions OpenCodeInfiniteBridge but belongs to the user\nexport const UserPlugin = () => ({});\n');
  await assert.rejects(catalog.connect(input), /No se sobrescribió/iu);
});

test('una reconexión explícita redescubre el sidecar aunque conserve la misma referencia', async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  const registryFile = path.join(fx.registry, 'bridge.json');
  await writeFile(registryFile, JSON.stringify(fx.descriptor));
  const catalog = new OpenCodeDesktopBridgeCatalog(() => undefined, fx.dependencies);
  t.after(() => catalog.close());
  const input = { workspace: fx.workspace, binary: null, attach: null, sessionRef: null };

  await catalog.connect(input);
  assert.equal(catalog.endpointForSession('ses_visible1').endpoint, fx.descriptor.endpoint);

  const replacement = {
    ...fx.descriptor,
    bridgeId: 'e'.repeat(32),
    endpoint: 'http://127.0.0.1:43112',
    token: 'f'.repeat(64),
    startedAt: new Date(Date.now() + 1_000).toISOString(),
  };
  fx.known.delete(fx.descriptor.endpoint);
  fx.known.set(replacement.endpoint, replacement);
  await writeFile(registryFile, JSON.stringify(replacement));

  await catalog.connect(input);
  assert.equal(catalog.endpointForSession('ses_visible1').endpoint, replacement.endpoint);
  assert.equal(fx.auth.has(fx.descriptor.endpoint), false);
});

test('un sidecar cuyo SSE falla no oculta las sesiones de los demás sidecars', async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  const failingDescriptor = {
    ...fx.descriptor,
    bridgeId: 'e'.repeat(32),
    endpoint: 'http://127.0.0.1:43112',
    token: 'f'.repeat(64),
    pid: 5678,
    projectID: 'project-2',
    directory: fx.otherWorkspace,
    worktree: fx.otherWorkspace,
  };
  fx.known.set(failingDescriptor.endpoint, failingDescriptor);
  await Promise.all([
    writeFile(path.join(fx.registry, 'bridge.json'), JSON.stringify(fx.descriptor)),
    writeFile(path.join(fx.registry, 'failing.json'), JSON.stringify(failingDescriptor)),
  ]);
  let failingAborted = false;
  const catalog = new OpenCodeDesktopBridgeCatalog(() => undefined, {
    ...fx.dependencies,
    server: {
      ...fx.dependencies.server,
      startEventStream(options) {
        if (options.base !== failingDescriptor.endpoint) return fx.eventStream;
        return {
          ready: Promise.reject(new Error('SSE rechazado')),
          subscribe() { return () => undefined; },
          abort() { failingAborted = true; },
        };
      },
    },
  });
  t.after(() => catalog.close());

  const result = await catalog.connect({ workspace: fx.workspace, binary: null, attach: null, sessionRef: null });
  assert.deepEqual(result.sessions.map((session) => session.id), ['ses_mixed1', 'ses_visible1']);
  assert.equal(failingAborted, true);
  assert.equal(fx.auth.has(failingDescriptor.endpoint), false);
});

test('la reconciliación retira un sidecar sin cortar la autenticación de una ejecución activa', async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  const failingDescriptor = {
    ...fx.descriptor,
    bridgeId: 'e'.repeat(32),
    endpoint: 'http://127.0.0.1:43112',
    token: 'f'.repeat(64),
    pid: 5678,
    projectID: 'project-2',
    directory: fx.otherWorkspace,
    worktree: fx.otherWorkspace,
  };
  fx.known.set(failingDescriptor.endpoint, failingDescriptor);
  await Promise.all([
    writeFile(path.join(fx.registry, 'bridge.json'), JSON.stringify(fx.descriptor)),
    writeFile(path.join(fx.registry, 'failing.json'), JSON.stringify(failingDescriptor)),
  ]);
  let failSecond = false;
  const catalog = new OpenCodeDesktopBridgeCatalog(() => undefined, {
    ...fx.dependencies,
    server: {
      ...fx.dependencies.server,
      startEventStream() { return stream(); },
      async request(base, method, pathname, body, options) {
        if (failSecond && base === failingDescriptor.endpoint && pathname === '/session') {
          throw new Error('sidecar terminado');
        }
        return fx.dependencies.server.request(base, method, pathname, body, options);
      },
    },
  });
  t.after(() => catalog.close());

  await catalog.connect({ workspace: fx.workspace, binary: null, attach: null, sessionRef: null });
  assert.equal(fx.auth.has(failingDescriptor.endpoint), true);
  failSecond = true;
  await catalog.reconcile();
  assert.equal(fx.auth.has(failingDescriptor.endpoint), true);
  await catalog.reconcile();
  assert.equal(fx.auth.has(failingDescriptor.endpoint), true);
  const sessions = await catalog.reconcile();

  assert.deepEqual(sessions.map((session) => session.id), ['ses_mixed1', 'ses_visible1']);
  assert.equal(fx.auth.get(failingDescriptor.endpoint), failingDescriptor.token);
  await catalog.close();
  assert.equal(fx.auth.has(failingDescriptor.endpoint), false);
});

test('un bridge vivo de una compilación anterior exige reinicio sin registrar su token', async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  const oldPlugin = '// opencode-infinite-agent:desktop-bridge\nexport const OldBridge = async () => ({});\n';
  await mkdir(path.dirname(fx.pluginDestination), { recursive: true });
  await writeFile(fx.pluginDestination, oldPlugin);
  fx.descriptor.buildId = createHash('sha256').update(oldPlugin).digest('hex');
  await writeFile(path.join(fx.registry, 'bridge.json'), JSON.stringify(fx.descriptor));
  const catalog = new OpenCodeDesktopBridgeCatalog(() => undefined, fx.dependencies);
  t.after(() => catalog.close());

  await assert.rejects(
    catalog.connect({ workspace: fx.workspace, binary: null, attach: null, sessionRef: null }),
    /actualizada correctamente.*vuelve a abrir OpenCode Desktop/iu,
  );
  assert.equal(await readFile(fx.pluginDestination, 'utf8'), fx.pluginSourceText);
  assert.equal(fx.calls.some((call) => call.type === 'register'), false);
  assert.equal(fx.auth.size, 0);
});

test('el descubrimiento elimina descriptores de procesos que ya terminaron', async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  const registryFile = path.join(fx.registry, 'dead.json');
  await writeFile(registryFile, JSON.stringify(fx.descriptor));
  const catalog = new OpenCodeDesktopBridgeCatalog(() => undefined, {
    ...fx.dependencies,
    processExists: () => false,
  });
  t.after(() => catalog.close());

  await assert.rejects(
    catalog.connect({ workspace: fx.workspace, binary: null, attach: null, sessionRef: null }),
    /vuelve a abrir OpenCode Desktop/iu,
  );
  await assert.rejects(access(registryFile), { code: 'ENOENT' });
});
