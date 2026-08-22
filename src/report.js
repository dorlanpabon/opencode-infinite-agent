const { excerpt } = require('./detect');

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}h ${m}m ${sec}s` : `${m}m ${sec}s`;
}

function statusLabel(status) {
  switch (status) {
    case 'complete': return 'COMPLETADA';
    case 'max-iterations': return 'LIMITE DE ITERACIONES';
    case 'aborted': return 'ABORTADA POR EL USUARIO';
    case 'error': return 'ERROR';
    default: return status.toUpperCase();
  }
}

function exitCodeFor(status) {
  switch (status) {
    case 'complete': return 0;
    case 'max-iterations': return 2;
    case 'aborted': return 130;
    default: return 1;
  }
}

function printReport({ status, reason, state, sessionId, cfg }, log) {
  const C = require('./log').colors;
  const line = '-'.repeat(62);
  log.banner('REPORTE FINAL');
  console.log(line);
  console.log(`Estado       : ${statusLabel(status)}`);
  console.log(`Motivo       : ${reason}`);
  console.log(`Sesion       : ${sessionId}`);
  console.log(`Iteraciones  : ${state.iterations} (limite ${cfg.maxIterations})`);
  console.log(`Duracion     : ${fmtDuration(Date.now() - state.startedAt)}`);
  console.log(`Tokens       : in=${state.tokens.input} out=${state.tokens.output} cacheR=${state.tokens.cacheRead} cacheW=${state.tokens.cacheWrite}`);
  console.log(`Costo total  : $${state.cost.toFixed(4)}`);
  console.log(line);
  if (state.lastText) {
    console.log('Ultimo mensaje del agente:');
    console.log(`  ${excerpt(state.lastText, 10)}`);
    console.log(line);
  }
  if (status !== 'complete') {
    console.log(`${C.yellow}La tarea NO termino en estado COMPLETADA.${C.reset}`);
    console.log(`Puedes reanudar la misma sesion cuando quieras:`);
    console.log(`  node bin/loop-agent.js --session ${sessionId} --dir <directorio>`);
  }
}

module.exports = { printReport, statusLabel, exitCodeFor, fmtDuration };
