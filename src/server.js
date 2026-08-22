const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');

function authHeaders() {
  const pass = process.env.OPENCODE_SERVER_PASSWORD;
  if (!pass) return {};
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
      headers: { 'content-type': 'application/json', ...authHeaders() },
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
    path.join(home, '.local', 'bin', 'opencode'),
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

function spawnServe(bin, cfg) {
  const useShell = process.platform === 'win32' && !/\.(exe)$/i.test(bin);
  const proc = spawn(bin, ['serve', '--port', String(cfg.port), '--hostname', cfg.hostname], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: useShell,
  });
  let stderrTail = '';
  proc.stderr.on('data', (d) => {
    stderrTail = (stderrTail + d.toString()).slice(-2000);
  });
  proc.on('error', () => {});
  return { proc, getStderr: () => stderrTail };
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

  for (const port of discoverLocalServerPorts()) {
    const base = `http://127.0.0.1:${port}`;
    const v = await health(base);
    if (v) {
      log.ok(`Servidor opencode descubierto en ${base} (v${v}), modo adjunto`);
      return { base, owned: false, proc: null };
    }
    log.debug(`Puerto ${port} pertenece a un proceso opencode pero no responde health (posible basic auth)`);
  }

  const bin = findBinary(cfg.opencodeBin);
  log.info(`Iniciando servidor headless: ${bin} serve --port ${cfg.port}`);
  const { proc, getStderr } = spawnServe(bin, cfg);
  const deadline = Date.now() + 90 * 1000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`El proceso del servidor murio (codigo ${proc.exitCode}). STDERR:\n${getStderr() || '(vacio)'}`);
    }
    version = await health(cfg.base);
    if (version) {
      log.ok(`Servidor listo en ${cfg.base} (v${version})`);
      return { base: cfg.base, owned: true, proc };
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  await killTree(proc);
  throw new Error(`El servidor no respondio /global/health tras 90s. STDERR:\n${getStderr() || '(vacio)'}`);
}

async function stopServer(handle) {
  if (!handle || !handle.owned || !handle.proc) return;
  await killTree(handle.proc);
}

function startEventListener({ base, sessionId, onResponseSent, debug }) {
  const ctl = new AbortController();
  (async () => {
    try {
      const res = await fetch(base.replace(/\/$/, '') + '/event', {
        headers: { accept: 'text/event-stream', ...authHeaders() },
        signal: ctl.signal,
      });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim());
            const type = String(ev.type || ev.name || '');
            if (/permission/i.test(type)) {
              const payload = ev.properties || ev.payload || ev.attributes || {};
              const sid = payload.sessionID || sessionId;
              const pid = payload.id || payload.permissionID;
              if (pid && sid) {
                await request(base, 'POST', `/session/${sid}/permissions/${pid}`, { response: 'once' }, { timeoutMs: 10000 });
                if (onResponseSent) onResponseSent(sid, pid);
              }
            }
          } catch (e) {
            if (debug) debug(`evento SSE no procesado: ${e.message}`);
          }
        }
      }
    } catch (e) {
      if (!ctl.signal.aborted && debug) debug(`stream SSE terminado: ${e.message}`);
    }
  })();
  return ctl;
}

module.exports = { request, health, findBinary, ensureServer, stopServer, startEventListener };
