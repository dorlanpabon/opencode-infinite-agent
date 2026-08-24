const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');

function authHeaders(base) {
  if (!base) throw new Error('authHeaders requiere el origen base');
  const pass = process.env.OPENCODE_SERVER_PASSWORD;
  if (!pass) return {};
  let origin;
  try {
    origin = new URL(base);
  } catch {
    throw new Error(`Origen OpenCode invalido: ${base}`);
  }
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
    throw new Error(`Protocolo OpenCode no permitido: ${origin.protocol}`);
  }
  const host = origin.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '[::1]' || host === '::1' || /^127\./u.test(host);
  if (!loopback) {
    throw new Error(`Se rechazo enviar OPENCODE_SERVER_PASSWORD fuera de loopback: ${origin.origin}`);
  }
  const user = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
  return { Authorization: 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') };
}

async function request(base, method, pathName, body, { timeoutMs = 30000 } = {}) {
  const url = base.replace(/\/$/, '') + pathName;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...authHeaders(base) },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!res.ok) {
      const detail = typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data)?.slice(0, 300);
      const err = new Error(`HTTP ${res.status} en ${method} ${pathName}: ${detail || '(sin cuerpo)'}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError' && timeoutMs) {
      throw new Error(`Timeout (${timeoutMs}ms) en ${method} ${pathName}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function health(base) {
  try {
    const data = await request(base, 'GET', '/global/health', null, { timeoutMs: 2500 });
    return data && data.healthy ? data.version || '?' : null;
  } catch {
    return null;
  }
}

function findBinary(explicit) {
  const exists = (p) => { try { return p && fs.existsSync(p); } catch { return false; } };
  if (explicit) {
    if (exists(explicit)) return explicit;
    throw new Error(`OPENCODE_BIN apunta a un archivo inexistente: ${explicit}`);
  }
  if (process.platform === 'win32') {
    try {
      const out = execSync('where.exe opencode 2>nul', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of out.split(/\r?\n/)) {
        const p = line.trim();
        if (p && /\.(exe|cmd|bat)$/i.test(p) && exists(p)) return p;
        if (p && exists(p)) return p;
      }
    } catch {}
  } else {
    try {
      const out = execSync('command -v opencode', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: '/bin/sh' });
      const p = out.trim();
      if (p && exists(p)) return p;
    } catch {}
  }
  const home = os.homedir();
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const localappdata = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const winCandidates = [
    path.join(localappdata, 'opencode', 'opencode-cli.exe'),
    path.join(localappdata, 'opencode', 'opencode.exe'),
    path.join(home, '.local', 'bin', 'opencode.exe'),
    path.join(home, '.bun', 'bin', 'opencode.exe'),
    path.join(appdata, 'npm', 'opencode.cmd'),
    path.join(appdata, 'npm', 'opencode'),
    path.join(home, 'scoop', 'shims', 'opencode.exe'),
    'C:\\ProgramData\\chocolatey\\bin\\opencode.exe',
    path.join(localappdata, 'Microsoft', 'WinGet', 'Links', 'opencode.exe'),
  ];
  const posixCandidates = [
    '/usr/local/bin/opencode',
    '/usr/bin/opencode',
    '/opt/homebrew/bin/opencode',
    path.join(home, '.local', 'bin', 'opencode'),
    path.join(home, '.opencode', 'bin', 'opencode'),
    path.join(home, '.bun', 'bin', 'opencode'),
  ];
  for (const c of process.platform === 'win32' ? winCandidates : posixCandidates) {
    if (exists(c)) return c;
  }
  throw new Error(
    'No se encontro el binario "opencode". Instalalo o define su ruta:\n' +
    '  - Variable de entorno OPENCODE_BIN=C:\\ruta\\a\\opencode.exe\n' +
    '  - O campo "opencodeBin" en .looprc.json'
  );
}

function spawnServe(bin, cfg, extraEnv) {
  const useShell = process.platform === 'win32' && !/\.(exe)$/i.test(bin);
  const proc = spawn(bin, ['serve', '--port', String(cfg.port), '--hostname', cfg.hostname], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: useShell,
    cwd: cfg.dir || undefined,
    env: { ...process.env, ...(extraEnv || {}) },
  });
  let stderrTail = '';
  proc.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-2000);
  });
  proc.on('error', () => {});
  return { proc, getStderr: () => stderrTail };
}

// crea un directorio con configuracion minima vacia para aislar al servidor
// de un config global del usuario que la version instalada no entienda
function isolatedConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-infinite-config-'));
  try {
    if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
    const sub = path.join(dir, 'opencode');
    fs.mkdirSync(sub, { mode: 0o700 });
    fs.writeFileSync(path.join(sub, 'opencode.json'), '{}\n', { mode: 0o600 });
    return dir;
  } catch (error) {
    removeIsolatedConfigDir(dir);
    throw error;
  }
}

function removeIsolatedConfigDir(dir) {
  if (!dir || path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('opencode-infinite-config-')) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

function killTree(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.exitCode !== null || proc.killed) return resolve();
    try {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('close', () => resolve());
        killer.on('error', () => { try { proc.kill(); } catch {} resolve(); });
      } else {
        proc.kill('SIGTERM');
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve(); }, 1500);
      }
    } catch {
      resolve();
    }
  });
}

// busca puertos de escucha de procesos opencode ya corriendo (TUI o app escritorio)
function discoverLocalServerPorts() {
  const ports = [];
  if (process.platform !== 'win32') return ports;
  const { execSync } = require('child_process');
  const opts = { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 };
  try {
    const tasklist = execSync('tasklist /FO CSV /NH', opts);
    const pids = new Set();
    for (const line of tasklist.split(/\r?\n/)) {
      const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
      if (m && /opencode/i.test(m[1])) pids.add(m[2]);
    }
    if (!pids.size) return ports;
    const netstat = execSync('netstat -ano', opts);
    for (const line of netstat.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5 || parts[0] !== 'TCP' || parts[3] !== 'LISTENING' || !pids.has(parts[4])) continue;
      const local = parts[1];
      if (!/^(127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):/.test(local)) continue;
      const port = parseInt(local.split(':').pop(), 10);
      if (port > 0 && !ports.includes(port)) ports.push(port);
    }
  } catch {}
  return ports;
}

async function ensureServer(cfg, log) {
  if (cfg.attach) {
    const version = await health(cfg.attach);
    if (!version) throw new Error(`No se pudo adjuntar a ${cfg.attach} (sin respuesta o credenciales incorrectas). Define OPENCODE_SERVER_PASSWORD si el servidor usa basic auth.`);
    log.ok(`Modo adjunto a ${cfg.attach} (v${version})`);
    return { base: cfg.attach, owned: false, proc: null };
  }

  let version = await health(cfg.base);
  if (version) {
    log.ok(`Servidor opencode ya activo en ${cfg.base} (v${version}), modo adjunto`);
    return { base: cfg.base, owned: false, proc: null };
  }

  if (cfg.discover) {
    for (const port of discoverLocalServerPorts()) {
      const base = `http://127.0.0.1:${port}`;
      const v = await health(base);
      if (v) {
        log.ok(`Servidor opencode descubierto en ${base} (v${v}), modo adjunto`);
        return { base, owned: false, proc: null };
      }
      log.debug(`Puerto ${port} pertenece a un proceso opencode pero no responde health (posible basic auth)`);
    }
  }

  const bin = findBinary(cfg.opencodeBin);
  log.info(`Iniciando servidor headless: ${bin} serve --port ${cfg.port}`);

  const attempts = [{ env: null, isolatedDir: null }];
  let retriedIsolated = false;

  for (const attempt of attempts) {
    const { proc, getStderr } = spawnServe(bin, cfg, attempt.env);
    const deadline = Date.now() + 90 * 1000;
    let started = false;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) break;
      const version = await health(cfg.base);
      if (version) {
        log.ok(`Servidor listo en ${cfg.base} (v${version})`);
        if (retriedIsolated) {
          log.warn('Se aisló la configuración (XDG_CONFIG_HOME temporal) porque el config global no es compatible con esta versión de opencode. MCPs y ajustes del config global NO se cargaron en este servidor.');
        }
        if (attempt.isolatedDir) proc.once('exit', () => removeIsolatedConfigDir(attempt.isolatedDir));
        return { base: cfg.base, owned: true, proc, isolatedDir: attempt.isolatedDir };
      }
      await new Promise((r) => setTimeout(r, 700));
    }

    const errTail = getStderr();
    await killTree(proc);
    if (attempt.isolatedDir) removeIsolatedConfigDir(attempt.isolatedDir);

    // config global incompatible → reintento con config aislada
    if (!started && proc.exitCode !== null && /Configuration is invalid/i.test(errTail) && !retriedIsolated) {
      log.warn('El config global de opencode es invalido para esta version del CLI. Reintentando con configuracion aislada...');
      const isolatedDir = isolatedConfigDir();
      attempts.push({ env: { XDG_CONFIG_HOME: isolatedDir }, isolatedDir });
      retriedIsolated = true;
      continue;
    }

    throw new Error(`El proceso del servidor murio (codigo ${proc.exitCode}). STDERR:\n${errTail || '(vacio)'}`);
  }
  throw new Error('No se pudo iniciar el servidor headless');
}

async function stopServer(handle) {
  if (!handle || !handle.owned || !handle.proc) return;
  await killTree(handle.proc);
}

function unwrapEvent(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.payload && typeof value.payload === 'object' && value.payload.type) return value.payload;
  return value.type ? value : null;
}

function parseSseFrames(buffer, onEvent) {
  const normalized = buffer.replace(/\r\n/g, '\n');
  let start = 0;
  let end;
  while ((end = normalized.indexOf('\n\n', start)) >= 0) {
    const frame = normalized.slice(start, end);
    start = end + 2;
    const data = frame.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      const event = unwrapEvent(JSON.parse(data));
      if (event) onEvent(event);
    } catch {}
  }
  return normalized.slice(start);
}

function abortableDelay(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

// Conexion SSE compartida. Los consumidores se suscriben antes del POST para
// no perder la transicion terminal; cada reconexion vuelve a emitir
// server.connected y permite reconciliar desde la API persistida.
function startEventStream({
  base,
  debug,
  fetchImpl = fetch,
  reconnectMinMs = 3000,
  reconnectMaxMs = 15000,
}) {
  const ctl = new AbortController();
  const listeners = new Set();
  const connectionWaiters = new Set();
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  let readyDone = false;
  let connected = false;

  function publish(event) {
    for (const listener of [...listeners]) {
      try {
        const result = listener(event);
        if (result && typeof result.catch === 'function') {
          result.catch((error) => { if (debug) debug(`consumidor SSE: ${error.message}`); });
        }
      } catch (error) {
        if (debug) debug(`consumidor SSE: ${error.message}`);
      }
    }
  }

  function markConnected() {
    connected = true;
    if (!readyDone) {
      readyDone = true;
      readyResolve();
    }
    for (const waiter of [...connectionWaiters]) waiter.resolve();
    connectionWaiters.clear();
    // Read-repair inmediato incluso si una version no entrega server.connected.
    publish({ type: 'server.connected', properties: { transport: true } });
  }

  function markDisconnected() {
    connected = false;
  }

  (async () => {
    let backoff = reconnectMinMs;
    while (!ctl.signal.aborted) {
      try {
        const res = await fetchImpl(base.replace(/\/$/, '') + '/event', {
          headers: { accept: 'text/event-stream', ...authHeaders(base) },
          signal: ctl.signal,
        });
        if (!res.ok || !res.body) {
          if (debug) debug(`SSE /event respondio ${res.status}; reintentando...`);
        } else {
          backoff = reconnectMinMs;
          markConnected();
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            buffer = parseSseFrames(buffer, publish);
          }
          markDisconnected();
          if (buffer.trim()) parseSseFrames(buffer + '\n\n', publish);
          if (debug && !ctl.signal.aborted) debug('SSE terminado; reconectando...');
        }
      } catch (error) {
        markDisconnected();
        if (ctl.signal.aborted) break;
        if (debug) debug(`SSE error: ${error.message}; reconectando...`);
      }
      await abortableDelay(backoff, ctl.signal);
      backoff = Math.min(backoff * 2, reconnectMaxMs);
    }
  })();

  return {
    ready,
    signal: ctl.signal,
    get connected() { return connected; },
    waitUntilConnected() {
      if (connected) return Promise.resolve();
      if (ctl.signal.aborted) return Promise.reject(new Error('SSE abortado'));
      return new Promise((resolve, reject) => connectionWaiters.add({ resolve, reject }));
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new Error('listener SSE invalido');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    abort() {
      ctl.abort();
      markDisconnected();
      for (const waiter of [...connectionWaiters]) waiter.reject(new Error('SSE abortado'));
      connectionWaiters.clear();
      listeners.clear();
    },
  };
}

// Auto-aprueba exclusivamente permission.asked de la sesion supervisada.
// No responde permission.updated/replied ni eventos v2 con otro contrato.
function startPermissionApprover({
  base,
  eventStream,
  sessionId,
  onResponseSent,
  debug,
  reply = 'once',
  requestFn = request,
}) {
  if (!eventStream || typeof eventStream.subscribe !== 'function') {
    throw new Error('Auto-approve requiere eventStream');
  }
  if (!sessionId) throw new Error('Auto-approve requiere sessionId');
  const handled = new Set();
  const inFlight = new Set();

  const unsubscribe = eventStream.subscribe(async (raw) => {
    const event = unwrapEvent(raw);
    if (!event || event.type !== 'permission.asked') return;
    const payload = event.properties || event.data || {};
    const sid = payload.sessionID || payload.sessionId;
    const pid = payload.id || payload.requestID;
    if (sid !== sessionId || !pid || handled.has(pid) || inFlight.has(pid)) return;

    inFlight.add(pid);
    let via = null;
    try {
      await requestFn(base, 'POST', `/permission/${pid}/reply`, { reply }, { timeoutMs: 10000 });
      via = 'nuevo';
    } catch {}
    if (!via) {
      try {
        await requestFn(base, 'POST', `/session/${sid}/permissions/${pid}`, { response: reply }, { timeoutMs: 10000 });
        via = 'legado';
      } catch {}
    }
    inFlight.delete(pid);
    if (via) {
      handled.add(pid);
      if (handled.size > 1000) handled.delete(handled.values().next().value);
      if (onResponseSent) onResponseSent(sid, pid, payload.permission || 'permission.asked', via);
    } else if (debug) {
      debug(`permiso ${pid}: sin respuesta exitosa`);
    }
  });

  return { abort: unsubscribe };
}

module.exports = {
  request,
  health,
  findBinary,
  ensureServer,
  stopServer,
  startEventStream,
  startPermissionApprover,
  authHeaders,
  unwrapEvent,
  parseSseFrames,
  isolatedConfigDir,
  removeIsolatedConfigDir,
};
