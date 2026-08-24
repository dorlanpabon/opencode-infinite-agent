const { randomBytes } = require('crypto');
const { assistantText, hasSentinel, todosDone, excerpt, messageError, usageOf } = require('./detect');
const { continuationPrompt } = require('./session');
const {
  createSessionTurnMonitor,
  terminalMessageIds,
  TurnMonitorTimeout,
  SessionTurnError,
  TurnMonitorAborted,
  isTerminalAssistant,
} = require('./turn-monitor');

class LoopAborted extends Error {
  constructor() { super('Interrumpido por el usuario (Ctrl+C)'); }
}
class LoopStalled extends Error {}

// Backoff abortable usado solo para fallos confirmados de transporte/HTTP.
function sleepAbortable(ms, flag) {
  return new Promise((resolve) => {
    if (ms <= 0 || flag.aborted) return resolve();
    const timer = setTimeout(done, ms);
    if (flag.signal) flag.signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      if (flag.signal) flag.signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

// construye el body de prompt_async con model/agent opcionales
const MESSAGE_ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
let lastMessageTimestamp = 0;
let messageCounter = 0;

function createMessageId(now = Date.now()) {
  if (now !== lastMessageTimestamp) {
    lastMessageTimestamp = now;
    messageCounter = 0;
  }
  messageCounter += 1;
  const current = BigInt.asUintN(48, BigInt(now) * 0x1000n + BigInt(messageCounter));
  const time = current.toString(16).padStart(12, '0');
  const entropy = [...randomBytes(14)].map((byte) => MESSAGE_ID_CHARS[byte % MESSAGE_ID_CHARS.length]).join('');
  return `msg_${time}${entropy}`;
}

function buildMessageBody(cfg, text, messageId = null) {
  const body = { parts: [{ type: 'text', text }] };
  if (messageId) body.messageID = messageId;
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

function isRunningStatus(status) {
  return status && (status.type === 'busy' || status.type === 'retry');
}

function isConfirmedPromptRejection(error) {
  const status = error && Number(error.status);
  return Number.isInteger(status) && status >= 400 && status < 500 && ![408, 425, 429].includes(status);
}

// Arma el monitor antes de prompt_async. Los eventos solo despiertan una
// reconciliacion; el siguiente prompt requiere assistant terminal persistido e idle.
async function exchange(req, sessionId, text, cfg, flag, monitor, log) {
  if (flag.aborted) throw new LoopAborted();
  await monitor.ready(cfg.eventConnectTimeoutMs);
  if (flag.aborted) throw new LoopAborted();
  const before = await monitor.snapshot();
  const known = terminalMessageIds(before.messages);
  if (isRunningStatus(before.status)) {
    const last = before.messages[before.messages.length - 1];
    if (last && last.info && last.info.role === 'assistant' &&
      ((last.info.time && last.info.time.completed) || last.info.error)) {
      // Puede ser el conocido desfase stale-busy de OpenCode: permitir que el
      // idle posterior cierre este terminal ya persistido.
      known.delete(last.info.id);
    }
  }
  const running = isRunningStatus(before.status);
  const messageId = running ? null : createMessageId();
  const ticket = monitor.waitForTerminal({
    knownMessageIds: known,
    expectedParentId: messageId,
    timeoutMs: cfg.stallTimeoutMs,
    hardTimeoutMs: cfg.turnHardTimeoutMs,
    signal: flag.signal,
  });

  // Al reanudar una sesion que aun trabaja, no inyectar otro mensaje. Esperar
  // el terminal del turno existente y evaluarlo primero.
  if (running) {
    log.info(`Sesion ${before.status.type}: esperando que termine el turno activo`);
    void ticket.reconcile().catch((error) => log.debug(`Reconciliacion: ${error.message}`));
    try {
      return await ticket.promise;
    } catch (error) {
      if (error instanceof TurnMonitorAborted || flag.aborted) throw new LoopAborted();
      if (error instanceof TurnMonitorTimeout) throw new LoopStalled(error.message);
      throw error;
    }
  }

  try {
    // prompt_async evita mantener una respuesta HTTP abierta durante horas.
    await req('POST', `/session/${sessionId}/prompt_async`, buildMessageBody(cfg, text, messageId), { timeoutMs: 15000 });
  } catch (error) {
    // Solo un rechazo 4xx no ambiguo permite reintentar. Timeouts, 408/425/429
    // y 5xx pueden ocurrir despues de persistir el mensaje: esperamos la
    // respuesta correlacionada por parentID para no duplicar el prompt.
    if (isConfirmedPromptRejection(error)) {
      ticket.cancel(error);
      try { await ticket.promise; } catch {}
      throw error;
    }
    log.warn(`Resultado ambiguo al enviar prompt; reconciliando sin reenviar: ${error.message}`);
  }

  void ticket.reconcile().catch((error) => log.debug(`Reconciliacion: ${error.message}`));
  try {
    return await ticket.promise;
  } catch (error) {
    if (error instanceof TurnMonitorAborted || flag.aborted) throw new LoopAborted();
    if (error instanceof TurnMonitorTimeout) throw new LoopStalled(error.message);
    throw error;
  }
}

async function existingCompletion(req, sessionId, cfg, monitor, log) {
  const snapshot = await monitor.snapshot();
  if (isRunningStatus(snapshot.status)) return null;
  const terminal = [...snapshot.messages].reverse().find(isTerminalAssistant);
  if (!terminal) return null;
  const text = assistantText(terminal.parts);
  if (hasSentinel(text, cfg.sentinel)) {
    return { terminal, text, reason: `La sesion ya contiene el sentinel "${cfg.sentinel}"` };
  }
  if (!cfg.todoDetection) return null;
  try {
    const todos = await req('GET', `/session/${sessionId}/todo`);
    const td = todosDone(todos);
    if (td && td.done && td.total > 0) {
      return { terminal, text, reason: `La sesion ya tiene todos completados (${td.total}/${td.total})` };
    }
  } catch (error) {
    log.debug(`No se pudo verificar todos existentes: ${error.message}`);
  }
  return null;
}

// motor principal: itera hasta sentinel / todos completos / limites
async function runLoop({ req, sessionId, cfg, firstPrompt, flag, log, eventStream, onState, resumeExisting = false }) {
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
  const monitor = createSessionTurnMonitor({
    req,
    eventStream,
    sessionId,
    errorGraceMs: cfg.errorGraceMs,
    log,
  });

  log.banner(`LOOP INFINITO INICIADO | sesion ${sessionId} | max ${cfg.maxIterations} iteraciones`);

  try {
    if (resumeExisting) {
      const existing = await existingCompletion(req, sessionId, cfg, monitor, log);
      if (existing) {
        state.lastText = existing.text;
        return { status: 'complete', reason: existing.reason, state };
      }
    }
    for (let i = 1; i <= cfg.maxIterations; i++) {
      if (flag.aborted) { status = 'aborted'; reason = 'Interrumpido por el usuario'; break; }

      log.banner(`--- Iteracion ${i}/${cfg.maxIterations} ---`);
      if (onState) onState({ type: 'phase', phase: i === 1 ? 'working' : 'continuing', iteration: i });
      const prompt = i === 1 ? firstPrompt : continuationPrompt(cfg.sentinel);

      // intentos con reintentos ante fallos transitorios
      let reply = null;
      let attempt = 0;
      while (!reply && attempt <= cfg.retries) {
        attempt++;
        try {
          reply = await exchange(req, sessionId, prompt, cfg, flag, monitor, log);
          consecutiveErrors = 0;
        } catch (e) {
          if (e instanceof LoopAborted || flag.aborted) throw new LoopAborted();
          consecutiveErrors++;
          log.warn(`Fallo en el intercambio (intento ${attempt}/${cfg.retries + 1}, consecutivos: ${consecutiveErrors}): ${e.message}`);
          if (e instanceof LoopStalled || e instanceof SessionTurnError || consecutiveErrors >= cfg.maxConsecutiveErrors) {
            status = 'error';
            reason = e instanceof LoopStalled || e instanceof SessionTurnError
              ? e.message
              : `${consecutiveErrors} fallos consecutivos. Ultimo: ${e.message}`;
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
      if (onState) {
        onState({
          type: 'settling',
          phase: 'settling',
          iteration: i,
          tokens: { ...state.tokens },
          cost: state.cost,
          lastText: text,
        });
      }

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
    }
  } catch (e) {
    if (e instanceof LoopAborted || flag.aborted) {
      status = 'aborted';
      reason = 'Interrumpido por el usuario';
    } else {
      status = 'error';
      reason = e.message;
    }
  } finally {
    monitor.close();
  }

  return { status, reason, state };
}

module.exports = {
  runLoop,
  sleepAbortable,
  buildMessageBody,
  createMessageId,
  isConfirmedPromptRejection,
  existingCompletion,
  exchange,
  LoopAborted,
  LoopStalled,
};
