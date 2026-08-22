const { assistantText, hasSentinel, todosDone, excerpt, messageError, usageOf } = require('./detect');
const { continuationPrompt } = require('./session');

class LoopAborted extends Error {
  constructor() { super('Interrumpido por el usuario (Ctrl+C)'); }
}
class LoopStalled extends Error {}

// sleep que se despierta antes si flag.aborted
function sleepAbortable(ms, flag) {
  return new Promise((resolve) => {
    if (ms <= 0 || flag.aborted) return resolve();
    const timer = setTimeout(done, ms);
    const poll = setInterval(() => { if (flag.aborted) done(); }, 200);
    function done() { clearTimeout(timer); clearInterval(poll); resolve(); }
  });
}

// construye el body de prompt_async con model/agent opcionales
function buildMessageBody(cfg, text) {
  const body = { parts: [{ type: 'text', text }] };
  if (cfg.model && cfg.model.includes('/')) {
    const slash = cfg.model.indexOf('/');
    body.model = {
      providerID: cfg.model.slice(0, slash),
      modelID: cfg.model.slice(slash + 1),
    };
  }
  if (cfg.agent) body.agent = cfg.agent;
  return body;
}

// envia un mensaje asincrono y espera la respuesta nueva del assistant
async function exchange(req, sessionId, text, cfg, flag) {
  const before = await req('GET', `/session/${sessionId}/message`);
  const known = new Set((Array.isArray(before) ? before : []).map((m) => m.info && m.info.id).filter(Boolean));

  // envio asincrono evita timeouts HTTP en turnos largos del agente
  await req('POST', `/session/${sessionId}/prompt_async`, buildMessageBody(cfg, text), { timeoutMs: 15000 });

  const deadline = Date.now() + cfg.stallTimeoutMs;
  while (Date.now() < deadline) {
    if (flag.aborted) throw new LoopAborted();
    await sleepAbortable(cfg.pollMs, flag);
    if (flag.aborted) throw new LoopAborted();
    const msgs = await req('GET', `/session/${sessionId}/message`);
    const reply = (Array.isArray(msgs) ? msgs : []).find((m) =>
      m && m.info && !known.has(m.info.id) &&
      m.info.role === 'assistant' &&
      ((m.info.time && m.info.time.completed) || m.info.error)
    );
    if (reply) return reply;
  }
  try { await req('POST', `/session/${sessionId}/abort`, {}); } catch {}
  throw new LoopStalled(`Sin respuesta del agente tras ${cfg.stallTimeoutMin} min. Causa probable: dialogo de permiso pendiente. Soluciones: --auto-approve o ejecutar antes "loop-agent init-permissions --dir <proyecto>"`);
}

// motor principal: itera hasta sentinel / todos completos / limites
async function runLoop({ req, sessionId, cfg, firstPrompt, flag, log }) {
  const state = {
    startedAt: Date.now(),
    iterations: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    lastText: '',
  };

  let status = 'max-iterations';
  let reason = `Se alcanzo el limite de iteraciones (${cfg.maxIterations})`;
  let consecutiveErrors = 0;

  log.banner(`LOOP INFINITO INICIADO | sesion ${sessionId} | max ${cfg.maxIterations} iteraciones`);

  try {
    for (let i = 1; i <= cfg.maxIterations; i++) {
      if (flag.aborted) { status = 'aborted'; reason = 'Interrumpido por el usuario'; break; }

      log.banner(`--- Iteracion ${i}/${cfg.maxIterations} ---`);
      const prompt = i === 1 ? firstPrompt : continuationPrompt(cfg.sentinel);

      // intentos con reintentos ante fallos transitorios
      let reply = null;
      let attempt = 0;
      while (!reply && attempt <= cfg.retries) {
        attempt++;
        try {
          reply = await exchange(req, sessionId, prompt, cfg, flag);
          consecutiveErrors = 0;
        } catch (e) {
          if (e instanceof LoopAborted || flag.aborted) throw new LoopAborted();
          consecutiveErrors++;
          log.warn(`Fallo en el intercambio (intento ${attempt}/${cfg.retries + 1}, consecutivos: ${consecutiveErrors}): ${e.message}`);
          if (e instanceof LoopStalled || consecutiveErrors >= cfg.maxConsecutiveErrors) {
            status = 'error';
            reason = e instanceof LoopStalled ? e.message : `${consecutiveErrors} fallos consecutivos. Ultimo: ${e.message}`;
            break;
          }
          await sleepAbortable(cfg.retryDelayMs, flag);
        }
      }

      if (status === 'error') break;
      if (!reply && flag.aborted) { status = 'aborted'; reason = 'Interrumpido por el usuario'; break; }
      if (!reply) continue;

      state.iterations = i;
      const u = usageOf(reply.info);
      state.tokens.input += u.input;
      state.tokens.output += u.output;
      state.tokens.cacheRead += u.cacheRead;
      state.tokens.cacheWrite += u.cacheWrite;
      state.cost += u.cost;

      const text = assistantText(reply.parts);
      state.lastText = text;

      const agentErr = messageError(reply.info);
      if (agentErr) {
        consecutiveErrors++;
        log.warn(`El agente reporto error: ${JSON.stringify(agentErr).slice(0, 250)}`);
        if (consecutiveErrors >= cfg.maxConsecutiveErrors) {
          status = 'error';
          reason = 'Errores repetidos del agente/proveedor';
          break;
        }
        continue;
      }

      log.info(`Respuesta recibida (${u.output} tok salida, acumulado $${state.cost.toFixed(4)}):`);
      console.log(`  ${excerpt(text)}`);

      // senal 1: marcador textual de tarea completa
      if (hasSentinel(text, cfg.sentinel)) {
        status = 'complete';
        reason = `Sentinel "${cfg.sentinel}" detectado en la respuesta`;
        break;
      }

      // senal 2: todos de la sesion todos completados
      if (cfg.todoDetection) {
        let td = null;
        try {
          const todos = await req('GET', `/session/${sessionId}/todo`);
          td = todosDone(todos);
        } catch (e) {
          log.debug(`No se pudo consultar todos: ${e.message}`);
        }
        if (td) {
          log.info(`Progreso todos: ${td.completed}/${td.total}`);
          if (td.done && td.total > 0) {
            status = 'complete';
            reason = `Todos completados (${td.total}/${td.total})`;
            break;
          }
        }
      }

      if (i < cfg.maxIterations) await sleepAbortable(cfg.delayMs, flag);
    }
  } catch (e) {
    if (e instanceof LoopAborted || flag.aborted) {
      status = 'aborted';
      reason = 'Interrumpido por el usuario';
    } else {
      status = 'error';
      reason = e.message;
    }
  }

  return { status, reason, state };
}

module.exports = { runLoop, sleepAbortable, buildMessageBody, exchange, LoopAborted, LoopStalled };
