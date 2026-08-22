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
  pollMs: 2000,
  sentinel: '[TASK_COMPLETE]',
  todoDetection: true,
  autoApprove: false,
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

function loadConfig(args = {}) {
  const dir = args.dir ? path.resolve(args.dir) : null;
  const file = findConfigFile({ dir, cfgFile: args.config || null });
  const fromFile = file ? readJsonFile(file) : null;

  const cfg = { ...DEFAULTS, ...(fromFile || {}) };

  applyEnv(cfg);

  if (args.port != null) cfg.port = num(args.port, cfg.port);
  if (args.hostname != null) cfg.hostname = args.hostname;
  if (args.maxIterations != null) cfg.maxIterations = num(args.maxIterations, cfg.maxIterations);
  if (args.delayMs != null) cfg.delayMs = num(args.delayMs, cfg.delayMs);
  if (args.retries != null) cfg.retries = num(args.retries, cfg.retries);
  if (args.retryDelayMs != null) cfg.retryDelayMs = num(args.retryDelayMs, cfg.retryDelayMs);
  if (args.maxConsecutiveErrors != null) cfg.maxConsecutiveErrors = num(args.maxConsecutiveErrors, cfg.maxConsecutiveErrors);
  if (args.stallTimeoutMin != null) cfg.stallTimeoutMin = num(args.stallTimeoutMin, cfg.stallTimeoutMin);
  if (args.pollMs != null) cfg.pollMs = num(args.pollMs, cfg.pollMs);
  if (args.sentinel != null) cfg.sentinel = args.sentinel;
  if (args.model != null) cfg.model = args.model;
  if (args.agent != null) cfg.agent = args.agent;
  if (args.title != null) cfg.title = args.title;
  if (args.attach != null) cfg.attach = args.attach;
  if (args.noTodos) cfg.todoDetection = false;
  if (args.autoApprove) cfg.autoApprove = true;
  if (args.keepServer) cfg.keepServer = true;
  if (args.verbose) cfg.verbose = true;

  cfg.stallTimeoutMs = cfg.stallTimeoutMin * 60 * 1000;
  cfg.base = `http://${cfg.hostname}:${cfg.port}`;
  cfg.configFileUsed = file;

  if (!cfg.sentinel || typeof cfg.sentinel !== 'string') throw new Error('sentinel invalido en configuracion');
  if (cfg.maxIterations < 1) throw new Error('maxIterations debe ser >= 1');
  if (cfg.delayMs < 0) throw new Error('delayMs no puede ser negativo');
  if (cfg.attach && !/^https?:\/\//i.test(cfg.attach)) throw new Error('--attach debe ser una URL http(s), ej: http://127.0.0.1:4096');

  return cfg;
}

module.exports = { DEFAULTS, loadConfig };
