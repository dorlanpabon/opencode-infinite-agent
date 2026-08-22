const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};

let verbose = false;

function setVerbose(v) { verbose = !!v; }
function isVerbose() { return verbose; }

function ts() {
  return new Date().toISOString().slice(11, 19);
}

module.exports = {
  setVerbose,
  isVerbose,
  colors: C,
  info: (m) => console.log(`${C.dim}[${ts()}]${C.reset} ${m}`),
  ok: (m) => console.log(`${C.dim}[${ts()}]${C.reset} ${C.green}${m}${C.reset}`),
  warn: (m) => console.log(`${C.dim}[${ts()}]${C.reset} ${C.yellow}${m}${C.reset}`),
  err: (m) => console.error(`${C.dim}[${ts()}]${C.reset} ${C.red}${m}${C.reset}`),
  debug: (m) => { if (verbose) console.log(`${C.dim}[${ts()}] ${C.blue}DEBUG${C.reset} ${typeof m === 'string' ? m : JSON.stringify(m)}`); },
  banner: (m) => console.log(`\n${C.bold}${C.cyan}${m}${C.reset}`),
};
