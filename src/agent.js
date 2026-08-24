const path = require('path');
const { loadConfig } = require('./config');
const server = require('./server');
const { resolveSession, initialPrompt, resumePrompt } = require('./session');
const { runLoop } = require('./loop');

function noop() {}

function normalizeLogger(logger) {
  const target = logger || {};
  return {
    banner: typeof target.banner === 'function' ? target.banner.bind(target) : noop,
    ok: typeof target.ok === 'function' ? target.ok.bind(target) : (target.info || noop).bind(target),
    info: typeof target.info === 'function' ? target.info.bind(target) : noop,
    warn: typeof target.warn === 'function' ? target.warn.bind(target) : noop,
    err: typeof target.err === 'function' ? target.err.bind(target) : (target.error || noop).bind(target),
    error: typeof target.error === 'function' ? target.error.bind(target) : (target.err || noop).bind(target),
    debug: typeof target.debug === 'function' ? target.debug.bind(target) : noop,
  };
}

function waitForReady(promise, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('Interrumpido antes de conectar con eventos OpenCode'));
    const timer = setTimeout(() => finish(new Error('OpenCode no abrio el stream SSE /event a tiempo')), timeoutMs);
    const onAbort = () => finish(new Error('Interrumpido antes de conectar con eventos OpenCode'));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    promise.then(() => finish(), (error) => finish(error));
    function finish(error) {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    }
  });
}

async function executeAgent(input, options = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('Configuracion de ejecucion invalida');
  const logger = normalizeLogger(options.log);
  const configInput = {
    ...input,
    dir: input.dir ? path.resolve(input.dir) : process.cwd(),
  };
  if (Object.prototype.hasOwnProperty.call(input, 'binary')) configInput.opencodeBin = input.binary;
  else if (Object.prototype.hasOwnProperty.call(input, 'opencodeBin')) configInput.opencodeBin = input.opencodeBin;
  const cfg = loadConfig(configInput);
  const signal = options.signal || new AbortController().signal;
  const flag = { aborted: signal.aborted, signal };
  let handle = null;
  let eventStream = null;
  let approver = null;
  let session = null;
  let req = null;

  const abort = () => {
    flag.aborted = true;
    if (req && session) {
      void req('POST', `/session/${session.id}/abort`, {}, { timeoutMs: 5000 }).catch(noop);
    }
  };
  signal.addEventListener('abort', abort, { once: true });

  try {
    if (input.exclusiveServer && !cfg.attach) {
      cfg.discover = false;
      cfg.port = await server.findAvailableLoopbackPort();
      cfg.base = `http://${cfg.hostname}:${cfg.port}`;
    }
    handle = await server.ensureServer(cfg, logger, { signal });
    req = (method, pathname, body, requestOptions) => server.request(handle.base, method, pathname, body, {
      ...(requestOptions || {}),
      directory: cfg.dir,
    });
    if (options.onTransport) options.onTransport('connecting');
    eventStream = server.startEventStream({ base: handle.base, directory: cfg.dir, signal, debug: logger.debug });
    await waitForReady(eventStream.ready, 15_000, signal);
    if (options.onTransport) options.onTransport('connected');

    const ref = input.deeplink || input.session || input.ref || null;
    const resolved = await resolveSession(req, {
      ref,
      title: cfg.title || (input.prompt ? `loop: ${String(input.prompt).slice(0, 60)}` : undefined),
    });
    session = resolved.session;
    if (options.onSession) options.onSession(session.id);
    logger.ok(`${resolved.created ? 'Sesion creada' : 'Sesion reanudada'}: ${session.id}`);

    if (cfg.autoApprove) {
      approver = server.startPermissionApprover({
        base: handle.base,
        directory: cfg.dir,
        eventStream,
        sessionId: session.id,
        signal,
        onResponseSent: (_sid, permissionId) => logger.warn(`Permiso auto-aprobado: ${permissionId}`),
        debug: logger.debug,
      });
    }

    const firstPrompt = input.prompt
      ? initialPrompt(String(input.prompt), cfg.sentinel)
      : resumePrompt(cfg.sentinel);
    const result = await runLoop({
      req,
      sessionId: session.id,
      cfg,
      firstPrompt,
      flag,
      log: logger,
      eventStream,
      onState: options.onState,
      resumeExisting: !input.prompt,
    });
    return { ...result, sessionId: session.id, serverBase: handle.base, ownedServer: handle.owned };
  } finally {
    signal.removeEventListener('abort', abort);
    if (approver) approver.abort();
    if (eventStream) eventStream.abort();
    if (options.onTransport) options.onTransport('closed');
    if (handle && handle.owned && !cfg.keepServer) await server.stopServer(handle);
  }
}

module.exports = { executeAgent, normalizeLogger, waitForReady };
