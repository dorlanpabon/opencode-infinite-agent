const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  port: 4567,
  hostname: '127.0.0.1',
  maxIterations: 100,
  delayMs: 4000,
  retries: 3,
  retryDelayMs: 4000,
  maxConsecutiveErrors: 4,
  stallTimeoutMin: 20,
  turnHardTimeoutMin: 180,
  errorGraceMs: 750,
  eventConnectTimeoutMs: 15000,
  pollMs: 2000,
  sentinel: '[TASK_COMPLETE]',
  todoDetection: true,
  autoApprove: false,
  discover: true,
  keepServer: false,
  verbose: false,
  model: null,
  agent: null,
  title: null,
};

function readJsonFile(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') return data;
    return null;
  } catch {
    return null;
  }
}

function findConfigFile({ dir, cfgFile }) {
  if (cfgFile) {
    if (!fs.existsSync(cfgFile)) throw new Error(`Archivo de configuracion no encontrado: ${cfgFile}`);
    return cfgFile;
  }
  const candidates = [];
  if (dir) candidates.push(path.join(dir, '.looprc.json'));
  candidates.push(path.join(__dirname, '..', '.looprc.json'));
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function applyEnv(cfg) {
  const env = process.env;
  if (env.LOOP_PORT && !isNaN(parseInt(env.LOOP_PORT, 10))) cfg.port = parseInt(env.LOOP_PORT, 10);
  if (env.LOOP_SENTINEL) cfg.sentinel = env.LOOP_SENTINEL;
  if (env.OPENCODE_BIN) cfg.opencodeBin = env.OPENCODE_BIN;
}

function num(v, fallback) {
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

function normalizeLoopbackUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('--attach debe ser una URL http(s) loopback, ej: http://127.0.0.1:4096');
  }
  const host = url.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '[::1]' || host === '::1' || /^127\./u.test(host);
  if (!['http:', 'https:'].includes(url.protocol) || !loopback || url.username || url.password
    || url.search || url.hash || (url.pathname !== '' && url.pathname !== '/')) {
    throw new Error('--attach solo admite un origen HTTP(S) loopback sin credenciales, ruta, query ni fragmento');
  }
  return url.origin;
}

function loadConfig(args = {}) {
  const dir = args.dir ? path.resolve(args.dir) : null;
  const file = findConfigFile({ dir, cfgFile: args.config || null });
  const fromFile = file ? readJsonFile(file) : null;

  const cfg = { ...DEFAULTS, ...(fromFile || {}) };

  applyEnv(cfg);

  cfg.dir = dir;
  if (args.port != null) cfg.port = num(args.port, cfg.port);
  if (args.hostname != null) cfg.hostname = args.hostname;
  if (args.maxIterations != null) cfg.maxIterations = num(args.maxIterations, cfg.maxIterations);
  if (args.delayMs != null) cfg.delayMs = num(args.delayMs, cfg.delayMs);
  if (args.retries != null) cfg.retries = num(args.retries, cfg.retries);
  if (args.retryDelayMs != null) cfg.retryDelayMs = num(args.retryDelayMs, cfg.retryDelayMs);
  if (args.maxConsecutiveErrors != null) cfg.maxConsecutiveErrors = num(args.maxConsecutiveErrors, cfg.maxConsecutiveErrors);
  if (args.stallTimeoutMin != null) cfg.stallTimeoutMin = num(args.stallTimeoutMin, cfg.stallTimeoutMin);
  if (args.turnHardTimeoutMin != null) cfg.turnHardTimeoutMin = num(args.turnHardTimeoutMin, cfg.turnHardTimeoutMin);
  if (args.errorGraceMs != null) cfg.errorGraceMs = num(args.errorGraceMs, cfg.errorGraceMs);
  if (args.eventConnectTimeoutMs != null) cfg.eventConnectTimeoutMs = num(args.eventConnectTimeoutMs, cfg.eventConnectTimeoutMs);
  if (args.pollMs != null) cfg.pollMs = num(args.pollMs, cfg.pollMs);
  if (args.sentinel != null) cfg.sentinel = args.sentinel;
  if (Object.prototype.hasOwnProperty.call(args, 'model')) cfg.model = args.model || null;
  if (Object.prototype.hasOwnProperty.call(args, 'agent')) cfg.agent = args.agent || null;
  if (Object.prototype.hasOwnProperty.call(args, 'title')) cfg.title = args.title || null;
  if (Object.prototype.hasOwnProperty.call(args, 'opencodeBin')) cfg.opencodeBin = args.opencodeBin || null;
  if (Object.prototype.hasOwnProperty.call(args, 'attach')) {
    cfg.attach = args.attach ? normalizeLoopbackUrl(args.attach) : null;
  }
  if (args.noTodos != null) cfg.todoDetection = !Boolean(args.noTodos);
  if (args.autoApprove != null) cfg.autoApprove = Boolean(args.autoApprove);
  if (args.noDiscover != null) cfg.discover = !Boolean(args.noDiscover);
  if (args.keepServer != null) cfg.keepServer = Boolean(args.keepServer);
  if (args.verbose != null) cfg.verbose = Boolean(args.verbose);

  cfg.errorGraceMs = num(cfg.errorGraceMs, DEFAULTS.errorGraceMs);
  cfg.eventConnectTimeoutMs = num(cfg.eventConnectTimeoutMs, DEFAULTS.eventConnectTimeoutMs);
  cfg.turnHardTimeoutMin = num(cfg.turnHardTimeoutMin, DEFAULTS.turnHardTimeoutMin);
  cfg.stallTimeoutMs = cfg.stallTimeoutMin * 60 * 1000;
  cfg.turnHardTimeoutMs = cfg.turnHardTimeoutMin * 60 * 1000;
  cfg.base = `http://${cfg.hostname}:${cfg.port}`;
  cfg.configFileUsed = file;

  if (!cfg.sentinel || typeof cfg.sentinel !== 'string') throw new Error('sentinel invalido en configuracion');
  if (cfg.maxIterations < 1) throw new Error('maxIterations debe ser >= 1');
  if (cfg.delayMs < 0) throw new Error('delayMs no puede ser negativo');
  if (cfg.errorGraceMs < 0) throw new Error('errorGraceMs no puede ser negativo');
  if (cfg.eventConnectTimeoutMs < 1) throw new Error('eventConnectTimeoutMs debe ser >= 1');
  if (cfg.turnHardTimeoutMin < 1) throw new Error('turnHardTimeoutMin debe ser >= 1');
  if (cfg.hostname !== '127.0.0.1' && cfg.hostname !== 'localhost') {
    throw new Error('hostname debe ser 127.0.0.1 o localhost; el servidor administrado no se expone a la red');
  }
  if (cfg.attach) cfg.attach = normalizeLoopbackUrl(cfg.attach);

  return cfg;
}

module.exports = { DEFAULTS, loadConfig, normalizeLoopbackUrl };
