const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { assistantText, hasSentinel, todosDone, excerpt, messageError, usageOf } = require('./detect');
const { continuationPrompt } = require('./session');
const {
  createSessionTurnMonitor,
  terminalMessageIds,
  messageIds,
  unresolvedTurnParentIds,
  TurnMonitorTimeout,
  SessionTurnError,
  TurnMonitorAborted,
  TurnCorrelationError,
  isTerminalAssistant,
} = require('./turn-monitor');

class LoopAborted extends Error {
  constructor() { super('Interrumpido por el usuario (Ctrl+C)'); }
}
class LoopStalled extends Error {}
class UnsafeSessionHistoryError extends Error {}

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

function buildMessageBody(cfg, text, attachments = []) {
  const marker = `<!-- opencode-infinite-agent-turn:${randomUUID()} -->`;
  const body = {
    parts: [
      { type: 'text', text },
      ...attachments.map((attachment) => ({
        type: 'file',
        mime: attachment.mime,
        filename: attachment.name,
        url: pathToFileURL(attachment.path).href,
      })),
      { type: 'text', text: marker, synthetic: true, ignored: true },
    ],
  };
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

function hasUnsafeWrappedHistory(messages, now = Date.now()) {
  const current = BigInt.asUintN(48, BigInt(now) * 0x1000n).toString(16).padStart(12, '0');
  return (Array.isArray(messages) ? messages : []).some((message) => {
    const info = message && message.info;
    const match = info && typeof info.id === 'string' && /^msg_([0-9a-f]{12})/u.exec(info.id);
    const created = info && info.time && Number(info.time.created);
    return Boolean(match && Number.isFinite(created) && created < now - 60000 && match[1] > current);
  });
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
async function awaitTicket(ticket, flag) {
  try {
    return await ticket.promise;
  } catch (error) {
    if (error instanceof TurnMonitorAborted || flag.aborted) throw new LoopAborted();
    if (error instanceof TurnMonitorTimeout) throw new LoopStalled(error.message);
    throw error;
  }
}

async function exchange(req, sessionId, text, cfg, flag, monitor, log, {
  adoptRunning = false,
  attachments = [],
  beforeSend,
} = {}) {
  let mayAdoptRunning = Boolean(adoptRunning);
  for (;;) {
    if (flag.aborted) throw new LoopAborted();
    await monitor.ready(cfg.eventConnectTimeoutMs);
    if (flag.aborted) throw new LoopAborted();
    const before = await monitor.snapshot();

    if (hasUnsafeWrappedHistory(before.messages)) {
      throw new UnsafeSessionHistoryError(
        'La sesion mezcla historial anterior al wrap de IDs; crea una sesion nueva para evitar respuestas duplicadas'
      );
    }

    const baselineIds = messageIds(before.messages);
    const unresolvedParents = unresolvedTurnParentIds(before.messages);
    // turnos zombi: sin respuesta terminal y con horas de antiguedad son
    // restos de corridas muertas (stalls/abortos); se excluyen del conteo
    // para que la guarda no bloquee sesiones con historial contaminado
    const ZOMBIE_MS = 2 * 60 * 60 * 1000;
    const createdById = new Map(before.messages
      .filter((m) => m && m.info && m.info.id)
      .map((m) => [m.info.id, Number(m.info.time && m.info.time.created) || 0]));
    const freshUnresolved = [...unresolvedParents].filter((id) => {
      const created = createdById.get(id) || 0;
      return !created || (Date.now() - created) < ZOMBIE_MS;
    });
    if (freshUnresolved.length < unresolvedParents.size) {
      log.warn(`Ignorando ${unresolvedParents.size - freshUnresolved.length} turno(s) zombi sin resolver de corridas anteriores`);
    }
    if (freshUnresolved.length > 1) {
      throw new TurnCorrelationError('La sesion tiene multiples turnos recientes sin resolver; se detuvo para evitar duplicados');
    }
    let parentId = freshUnresolved.length === 1 ? freshUnresolved[0] : null;
    let staleBusyTerminal = null;
    if (isRunningStatus(before.status) && !parentId) {
      staleBusyTerminal = [...before.messages].reverse()
        .find((message) => isTerminalAssistant(message) && message.info.parentID);
      if (staleBusyTerminal) parentId = staleBusyTerminal.info.parentID;
    }
    if (isRunningStatus(before.status) || parentId) {
      if (!parentId) throw new TurnCorrelationError(
        'La sesion esta activa pero no tiene un unico turno correlacionable'
      );
      const known = terminalMessageIds(before.messages);
      const hasIncomplete = before.messages.some((message) => message && message.info &&
        message.info.role === 'assistant' && message.info.parentID === parentId && !isTerminalAssistant(message));
      if (!hasIncomplete) {
        const staleTerminal = staleBusyTerminal || [...before.messages].reverse()
          .find((message) => isTerminalAssistant(message) && message.info.parentID === parentId);
        if (staleTerminal) known.delete(staleTerminal.info.id);
      }
      const ticket = monitor.waitForTerminal({
        knownMessageIds: known,
        expectedParentId: parentId,
        timeoutMs: cfg.stallTimeoutMs,
        hardTimeoutMs: cfg.turnHardTimeoutMs,
        signal: flag.signal,
      });
      log.info(`Sesion ${before.status.type}: esperando el turno sin resolver ${parentId}`);
      void ticket.reconcile().catch((error) => log.debug(`Reconciliacion: ${error.message}`));
      const terminal = await awaitTicket(ticket, flag);
      if (mayAdoptRunning) {
        if (staleBusyTerminal) {
          const after = await monitor.snapshot();
          const freshTerminal = [...after.messages].reverse()
            .find((message) => isTerminalAssistant(message) && !baselineIds.has(message.info.id));
          if (freshTerminal) return freshTerminal;
        }
        return terminal;
      }
      mayAdoptRunning = false;
      continue;
    }

    if (!before.status || before.status.type === 'unknown') {
      throw new Error('No se pudo confirmar que la sesion esta idle; no se envio otro prompt');
    }

    if (beforeSend) await beforeSend();
    const body = buildMessageBody(cfg, text, attachments);
    const ticket = monitor.waitForTerminal({
      knownMessageIds: baselineIds,
      expectedUserParts: body.parts.filter((part) => part.type === 'text'),
      timeoutMs: cfg.stallTimeoutMs,
      hardTimeoutMs: cfg.turnHardTimeoutMs,
      signal: flag.signal,
    });

    try {
      // prompt_async evita mantener una respuesta HTTP abierta durante horas.
      // El servidor asigna el user messageID. El nonce criptografico persistido
      // en las partes permite descubrirlo sin generar IDs de cliente.
      await req('POST', `/session/${sessionId}/prompt_async`, body, { timeoutMs: 15000 });
    } catch (error) {
      // Solo un rechazo 4xx no ambiguo permite reintentar. Timeouts, 408/425/429
      // y 5xx pueden ocurrir despues de persistir el mensaje.
      if (isConfirmedPromptRejection(error)) {
        ticket.cancel(error);
        try { await ticket.promise; } catch {}
        throw error;
      }
      log.warn(`Resultado ambiguo al enviar prompt; reconciliando sin reenviar: ${error.message}`);
    }

    void ticket.reconcile().catch((error) => log.debug(`Reconciliacion: ${error.message}`));
    return await awaitTicket(ticket, flag);
  }
}

async function existingCompletion(req, sessionId, cfg, monitor, log) {
  const snapshot = await monitor.snapshot();
  if (!snapshot.status || snapshot.status.type !== 'idle' ||
    unresolvedTurnParentIds(snapshot.messages).size > 0) return null;
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
async function runLoop({
  req,
  sessionId,
  cfg,
  firstPrompt,
  firstAttachments = [],
  flag,
  log,
  eventStream,
  onState,
  resumeExisting = false,
  replaceObjective = false,
  beforeFirstPrompt,
}) {
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
    if (resumeExisting && !replaceObjective) {
      const existing = await existingCompletion(req, sessionId, cfg, monitor, log);
      if (existing) {
        state.lastText = existing.text;
        return { status: 'complete', reason: existing.reason, state };
      }
    }
    for (let i = 1; i <= cfg.maxIterations;) {
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
          reply = await exchange(req, sessionId, prompt, cfg, flag, monitor, log, {
            adoptRunning: resumeExisting && !replaceObjective && i === 1,
            attachments: i === 1 ? firstAttachments : [],
            beforeSend: i === 1 ? beforeFirstPrompt : undefined,
          });
        } catch (e) {
          if (e instanceof LoopAborted || flag.aborted) throw new LoopAborted();
          consecutiveErrors++;
          log.warn(`Fallo en el intercambio (intento ${attempt}/${cfg.retries + 1}, consecutivos: ${consecutiveErrors}): ${e.message}`);
          if (e instanceof LoopStalled || e instanceof SessionTurnError ||
            e instanceof TurnCorrelationError || e instanceof UnsafeSessionHistoryError ||
            consecutiveErrors >= cfg.maxConsecutiveErrors) {
            status = 'error';
            reason = e instanceof LoopStalled || e instanceof SessionTurnError ||
              e instanceof TurnCorrelationError || e instanceof UnsafeSessionHistoryError
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
        i++;
        continue;
      }
      consecutiveErrors = 0;

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
      i++;
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
  hasUnsafeWrappedHistory,
  isConfirmedPromptRejection,
  existingCompletion,
  exchange,
  LoopAborted,
  LoopStalled,
  UnsafeSessionHistoryError,
};
