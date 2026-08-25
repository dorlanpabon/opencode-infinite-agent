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
      if (pathname === '/session/ses_global1') {
        return { id: 'ses_global1', title: 'Global exacta', directory: otherWorkspace, projectID: 'global', time: { created: 3, updated: 5 } };
      }
      if (pathname === '/session/ses_globalmissing1') {
        return { id: 'ses_globalmissing1', title: 'Global sin ruta', projectID: 'global', time: { created: 3, updated: 5 } };
      }
      if (pathname === '/session/ses_globalforeign1') {
        return { id: 'ses_globalforeign1', title: 'Global ajena', directory: workspace, projectID: 'global', time: { created: 3, updated: 5 } };
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

test('connect propaga ConfigInvalidError sanitizado cuando GET de la sesión exacta responde 400', async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await writeFile(path.join(fx.registry, 'bridge.json'), JSON.stringify(fx.descriptor));
  const originalRequest = fx.dependencies.server.request;
  fx.dependencies.server.request = async (...args) => {
    if (args[2] === '/session/ses_configinvalid1') {
      const error = new Error(
        'HTTP 400 en GET /session/ses_configinvalid1: ConfigInvalidError: Configuración de OpenCode inválida; token="bridge-secret-value"',
      );
      error.status = 400;
      throw error;
    }
    return originalRequest(...args);
  };
  const catalog = new OpenCodeDesktopBridgeCatalog(() => undefined, fx.dependencies);
  t.after(() => catalog.close());

  await assert.rejects(
    catalog.connect({
      workspace: fx.workspace,
      binary: null,
      attach: null,
      sessionRef: 'ses_configinvalid1',
    }),
    (error) => {
      assert.equal(error.name, 'ConfigInvalidError');
      assert.equal(error.status, 400);
      assert.match(error.message, /Configuración de OpenCode inválida/iu);
      assert.match(error.message, /token="\[REDACTED\]/u);
      assert.doesNotMatch(error.message, /bridge-secret-value/u);
      return true;
    },
  );
});

test('reconcile propaga ConfigInvalidError de status aunque conserve un catálogo previo', async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await writeFile(path.join(fx.registry, 'bridge.json'), JSON.stringify(fx.descriptor));
  const originalRequest = fx.dependencies.server.request;
  let rejectStatus = false;
  fx.dependencies.server.request = async (...args) => {
    if (rejectStatus && args[2] === '/session/status') {
      const error = new Error('HTTP 400: ConfigInvalidError token="status-secret-value"');
      error.name = 'ConfigInvalidError';
      error.status = 400;
      throw error;
    }
    return originalRequest(...args);
  };
  const catalog = new OpenCodeDesktopBridgeCatalog(() => undefined, fx.dependencies);
  t.after(() => catalog.close());

  await catalog.connect({ workspace: fx.workspace, binary: null, attach: null, sessionRef: null });
  rejectStatus = true;
  await assert.rejects(catalog.reconcile(), (error) => {
    assert.equal(error.name, 'ConfigInvalidError');
    assert.equal(error.status, 400);
    assert.match(error.message, /token="\[REDACTED\]"/u);
    assert.doesNotMatch(error.message, /status-secret-value/u);
    return true;
  });
  assert.deepEqual(catalog.current().map((session) => session.id), ['ses_mixed1', 'ses_visible1']);
});

test('catálogo rechaza referencias ambiguas antes de consultar un sidecar', async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  const catalog = new OpenCodeDesktopBridgeCatalog(() => undefined, fx.dependencies);
  t.after(() => catalog.close());
  const exact = 'oc://renderer/server/c2lkZWNhcg/session/ses_adopted1';

  for (const sessionRef of [
    'prefix-ses_adopted1',
    'oc://evil/server/c2lkZWNhcg/session/ses_adopted1',
    'oc://renderer/server/otro/session/ses_adopted1',
    `${exact}?directory=C%3A%5Csecreto`,
    `${exact}/message`,
  ]) {
    await assert.rejects(
      catalog.connect({ workspace: fx.workspace, binary: null, attach: null, sessionRef }),
      /referencia.*no es válida/iu,
    );
  }
  assert.equal(fx.calls.length, 0);
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

test('conexiones concurrentes del mismo ID conservan workspaces y rutas separados', async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await writeFile(path.join(fx.registry, 'bridge.json'), JSON.stringify(fx.descriptor));
  const originalRequest = fx.dependencies.server.request;
  const routeDirectories = [];
  let releaseFirst;
  let markFirstStarted;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  fx.dependencies.server.request = async (...args) => {
    const [, , pathname, , options] = args;
    if (pathname !== '/session/ses_concurrent1') return originalRequest(...args);
    routeDirectories.push(options.directory);
    if (options.directory === fx.workspace) {
      markFirstStarted();
      await firstGate;
    }
    return {
      id: 'ses_concurrent1',
      title: 'Concurrente',
      directory: options.directory,
      projectID: 'global',
      time: { created: 5, updated: 6 },
    };
  };
  const catalog = new OpenCodeDesktopBridgeCatalog(() => undefined, fx.dependencies);
  t.after(() => catalog.close());
  const sessionRef = 'oc://renderer/server/c2lkZWNhcg/session/ses_concurrent1';

  const firstPromise = catalog.connect({
    workspace: fx.workspace,
    binary: null,
    attach: null,
    sessionRef,
  });
  await firstStarted;
  const secondPromise = catalog.connect({
    workspace: fx.otherWorkspace,
    binary: null,
    attach: null,
    sessionRef,
  });
  releaseFirst();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.notStrictEqual(first, second);
  assert.equal(first.sessions.find((session) => session.id === 'ses_concurrent1')?.workspace, fx.workspace);
  assert.equal(second.sessions.find((session) => session.id === 'ses_concurrent1')?.workspace, fx.otherWorkspace);
  assert.deepEqual(routeDirectories, [fx.workspace, fx.otherWorkspace]);
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

test('adopta una sesión global exacta desde el workspace solicitado aunque no exista su descriptor', async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await writeFile(path.join(fx.registry, 'bridge.json'), JSON.stringify(fx.descriptor));
  const catalog = new OpenCodeDesktopBridgeCatalog(() => undefined, fx.dependencies);
  t.after(() => catalog.close());

  const result = await catalog.connect({
    workspace: fx.otherWorkspace,
    binary: null,
    attach: null,
    sessionRef: 'ses_global1',
  });

  const adopted = result.sessions.find((session) => session.id === 'ses_global1');
  assert.equal(adopted?.workspace, fx.otherWorkspace);
  assert.equal(catalog.endpointForSession('ses_global1').directory, fx.otherWorkspace);
  assert.equal(
    fx.calls.some((call) => call.pathname === '/session/ses_global1' && call.options.directory === fx.otherWorkspace),
    true,
  );
});

test('adopción global exacta exige una ruta absoluta explícita del workspace solicitado', async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  await writeFile(path.join(fx.registry, 'bridge.json'), JSON.stringify(fx.descriptor));
  const catalog = new OpenCodeDesktopBridgeCatalog(() => undefined, fx.dependencies);
  t.after(() => catalog.close());

  for (const sessionRef of ['ses_globalmissing1', 'ses_globalforeign1']) {
    const result = await catalog.connect({
      workspace: fx.otherWorkspace,
      binary: null,
      attach: null,
      sessionRef,
    });
    assert.equal(result.sessions.some((session) => session.id === sessionRef), false);
    assert.throws(() => catalog.endpointForSession(sessionRef), /no está disponible/iu);
  }
});

test('catálogo global solo incluye sesiones con ruta absoluta explícita del descriptor', async (t) => {
  const fx = await fixture();
  t.after(() => rm(fx.root, { recursive: true, force: true }));
  fx.descriptor.projectID = 'global';
  await writeFile(path.join(fx.registry, 'bridge.json'), JSON.stringify(fx.descriptor));
  const originalRequest = fx.dependencies.server.request;
  fx.dependencies.server.request = async (...args) => {
    if (args[2] === '/session') {
      return [
        { id: 'ses_globalvalid1', title: 'Global válida', directory: fx.workspace, projectID: 'global', time: { created: 1, updated: 5 } },
        { id: 'ses_globalmissing2', title: 'Global sin ruta', projectID: 'global', time: { created: 1, updated: 4 } },
        { id: 'ses_globalrelative1', title: 'Global relativa', directory: 'workspace', projectID: 'global', time: { created: 1, updated: 3 } },
        { id: 'ses_globalforeign2', title: 'Global ajena', directory: fx.otherWorkspace, projectID: 'global', time: { created: 1, updated: 2 } },
      ];
    }
    return originalRequest(...args);
  };
  const catalog = new OpenCodeDesktopBridgeCatalog(() => undefined, fx.dependencies);
  t.after(() => catalog.close());

  const result = await catalog.connect({ workspace: fx.workspace, binary: null, attach: null, sessionRef: null });
  assert.deepEqual(result.sessions.map((session) => session.id), ['ses_globalvalid1']);
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
