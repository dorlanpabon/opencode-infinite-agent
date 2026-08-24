class TurnMonitorTimeout extends Error {
  constructor(message) {
    super(message);
    this.name = 'TurnMonitorTimeout';
  }
}

class SessionTurnError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'SessionTurnError';
    this.detail = detail;
  }
}

class TurnMonitorAborted extends Error {
  constructor() {
    super('Interrumpido por el usuario');
    this.name = 'TurnMonitorAborted';
  }
}

function normalizeEvent(input) {
  if (!input || typeof input !== 'object') return null;
  if (input.payload && typeof input.payload === 'object' && input.payload.type) return input.payload;
  return input.type ? input : null;
}

function eventProperties(input) {
  const event = normalizeEvent(input);
  if (!event) return {};
  const value = event.properties || event.data || event.attributes;
  return value && typeof value === 'object' ? value : {};
}

function eventSessionId(input) {
  const props = eventProperties(input);
  return props.sessionID || props.sessionId ||
    (props.info && (props.info.sessionID || props.info.sessionId)) ||
    (props.message && (props.message.sessionID || props.message.sessionId)) ||
    (props.part && (props.part.sessionID || props.part.sessionId)) || null;
}

function isTerminalAssistant(message) {
  const info = message && message.info;
  return Boolean(info && info.id && info.role === 'assistant' &&
    ((info.time && info.time.completed) || info.error));
}

function terminalMessageIds(messages) {
  return new Set((Array.isArray(messages) ? messages : [])
    .filter(isTerminalAssistant)
    .map((message) => message.info.id));
}

function newestTerminal(messages, knownIds, expectedParentId = null) {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds || []);
  const candidates = (Array.isArray(messages) ? messages : [])
    .filter((message) => isTerminalAssistant(message) && !known.has(message.info.id)
      && (!expectedParentId || message.info.parentID === expectedParentId));
  return candidates.length ? candidates[candidates.length - 1] : null;
}

function sessionStatusOf(raw, sessionId) {
  if (!raw || typeof raw !== 'object') return { type: 'unknown' };
  if (Object.prototype.hasOwnProperty.call(raw, sessionId)) {
    const info = raw[sessionId];
    return info && typeof info === 'object' ? info : { type: 'idle' };
  }
  if (typeof raw.type === 'string') return raw;
  // OpenCode omite las sesiones idle del mapa /session/status.
  return { type: 'idle' };
}

function errorMessage(detail) {
  if (!detail) return 'OpenCode reporto un error de sesion';
  if (typeof detail === 'string') return detail;
  return detail.message || (detail.data && detail.data.message) ||
    (detail.error && errorMessage(detail.error)) || JSON.stringify(detail).slice(0, 500);
}

class SessionTurnMonitor {
  constructor({
    req,
    eventStream,
    sessionId,
    errorGraceMs = 750,
    log = null,
  }) {
    if (typeof req !== 'function') throw new Error('SessionTurnMonitor requiere req');
    if (!sessionId) throw new Error('SessionTurnMonitor requiere sessionId');
    this.req = req;
    this.eventStream = eventStream || null;
    this.sessionId = sessionId;
    this.errorGraceMs = Math.max(0, Number(errorGraceMs) || 0);
    this.log = log;
    this.active = null;
    this.reconciling = null;
    this.reconcileAgain = false;
    this.closed = false;
    this.unsubscribe = this.eventStream && typeof this.eventStream.subscribe === 'function'
      ? this.eventStream.subscribe((event) => this.onEvent(event))
      : null;
  }

  async snapshot() {
    const [messagesResult, statusResult] = await Promise.allSettled([
      this.req('GET', `/session/${this.sessionId}/message`),
      this.req('GET', '/session/status', null, { timeoutMs: 10000 }),
    ]);
    if (messagesResult.status === 'rejected') throw messagesResult.reason;
    return {
      messages: Array.isArray(messagesResult.value) ? messagesResult.value : [],
      status: statusResult.status === 'fulfilled'
        ? sessionStatusOf(statusResult.value, this.sessionId)
        : { type: 'unknown' },
    };
  }

  async ready(timeoutMs = 15000) {
    if (!this.eventStream) throw new Error('Monitor de turno requiere eventStream');
    const wait = typeof this.eventStream.waitUntilConnected === 'function'
      ? this.eventStream.waitUntilConnected()
      : this.eventStream.ready;
    if (!wait || typeof wait.then !== 'function') {
      throw new Error('eventStream no expone estado de conexion');
    }
    const ms = Math.max(1, Number(timeoutMs) || 15000);
    let timer;
    try {
      await Promise.race([
        wait,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`SSE no conecto dentro de ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  waitForTerminal({
    knownMessageIds,
    expectedParentId = null,
    timeoutMs,
    hardTimeoutMs,
    signal,
  }) {
    if (this.closed) throw new Error('SessionTurnMonitor cerrado');
    if (this.active) throw new Error('Ya hay un turno activo para esta sesion');

    const softMs = Math.max(1, Number(timeoutMs) || 20 * 60 * 1000);
    const hardMs = Math.max(softMs, Number(hardTimeoutMs) || 3 * 60 * 60 * 1000);
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const active = {
      knownIds: knownMessageIds instanceof Set ? new Set(knownMessageIds) : new Set(knownMessageIds || []),
      expectedParentId,
      resolve: resolvePromise,
      reject: rejectPromise,
      promise,
      softMs,
      hardDeadline: Date.now() + hardMs,
      watchdog: null,
      errorTimer: null,
      pendingError: null,
      idleSeen: false,
      sawBusy: false,
      statusType: 'unknown',
      signal: signal || null,
      abortHandler: null,
      settled: false,
    };
    this.active = active;

    if (active.signal) {
      active.abortHandler = () => this.rejectActive(new TurnMonitorAborted());
      if (active.signal.aborted) active.abortHandler();
      else active.signal.addEventListener('abort', active.abortHandler, { once: true });
    }
    if (!active.settled) this.armWatchdog(active.softMs);

    return {
      promise,
      reconcile: () => this.reconcile(),
      cancel: (reason) => this.rejectActive(reason || new Error('Espera de turno cancelada')),
    };
  }

  onEvent(input) {
    if (this.closed || !this.active) return;
    const event = normalizeEvent(input);
    if (!event) return;

    if (event.type === 'server.connected') {
      this.requestReconcile('server.connected');
      return;
    }

    if (eventSessionId(event) !== this.sessionId) return;
    const props = eventProperties(event);
    switch (event.type) {
      case 'session.status': {
        const status = props.status && typeof props.status === 'object' ? props.status : props;
        const type = status.type || 'unknown';
        this.active.statusType = type;
        if (type === 'idle') {
          this.active.idleSeen = true;
          this.requestReconcile('session.status idle');
        } else if (type === 'busy' || type === 'retry') {
          this.active.sawBusy = true;
          this.active.idleSeen = false;
          this.touch();
        }
        break;
      }
      case 'session.idle':
        this.active.statusType = 'idle';
        this.active.idleSeen = true;
        this.requestReconcile('session.idle');
        break;
      case 'session.error':
        this.recordSessionError(props.error || props);
        break;
      case 'message.updated':
        this.touch();
        this.requestReconcile('message.updated');
        break;
      case 'message.part.updated':
      case 'message.part.delta':
        this.touch();
        break;
      default:
        break;
    }
  }

  recordSessionError(detail) {
    const active = this.active;
    if (!active || active.settled) return;
    active.pendingError = { detail, dueAt: Date.now() + this.errorGraceMs };
    if (active.errorTimer) clearTimeout(active.errorTimer);
    active.errorTimer = setTimeout(() => {
      if (this.active === active && !active.settled) this.requestReconcile('session.error grace');
    }, this.errorGraceMs);
  }

  requestReconcile(source) {
    void this.reconcile().catch((error) => {
      const active = this.active;
      if (!active || active.settled) return;
      if (this.log && typeof this.log.debug === 'function') {
        this.log.debug(`Read-repair ${source} fallo: ${error.message}`);
      }
      this.armWatchdog(Math.min(active.softMs, Math.max(1, active.hardDeadline - Date.now())));
    });
  }

  touch() {
    const active = this.active;
    if (!active || active.settled) return;
    this.armWatchdog(active.softMs);
  }

  armWatchdog(ms) {
    const active = this.active;
    if (!active || active.settled) return;
    if (active.watchdog) clearTimeout(active.watchdog);
    active.watchdog = setTimeout(() => {
      if (this.active === active && !active.settled) void this.onWatchdog(active);
    }, ms);
  }

  async onWatchdog(active) {
    try {
      await this.reconcile();
    } catch (error) {
      if (this.active === active && !active.settled) this.rejectActive(error);
      return;
    }
    if (this.active !== active || active.settled) return;
    if ((active.statusType === 'busy' || active.statusType === 'retry') && Date.now() < active.hardDeadline) {
      this.armWatchdog(Math.min(active.softMs, Math.max(1, active.hardDeadline - Date.now())));
      return;
    }
    this.rejectActive(new TurnMonitorTimeout(
      `El turno no alcanzo un estado terminal persistido e idle dentro del tiempo permitido`
    ));
  }

  async reconcile() {
    if (this.closed || !this.active) return null;
    if (this.reconciling) {
      this.reconcileAgain = true;
      return this.reconciling;
    }

    this.reconciling = (async () => {
      do {
        this.reconcileAgain = false;
        const active = this.active;
        if (!active || active.settled) return null;
        const snapshot = await this.snapshot();
        if (this.active !== active || active.settled) return null;

        const terminal = newestTerminal(snapshot.messages, active.knownIds, active.expectedParentId);
        const type = snapshot.status.type || 'unknown';
        active.statusType = type;
        if (type === 'idle' && (terminal || active.sawBusy || active.pendingError)) active.idleSeen = true;
        else if (type === 'busy' || type === 'retry') {
          active.sawBusy = true;
          active.idleSeen = false;
        }

        if (terminal && active.idleSeen) {
          this.resolveActive(terminal);
          return terminal;
        }

        if (active.pendingError && Date.now() >= active.pendingError.dueAt && active.idleSeen && !terminal) {
          const detail = active.pendingError.detail;
          this.rejectActive(new SessionTurnError(errorMessage(detail), detail));
          return null;
        }
      } while (this.reconcileAgain && this.active);
      return null;
    })();

    try {
      return await this.reconciling;
    } finally {
      this.reconciling = null;
    }
  }

  resolveActive(value) {
    const active = this.active;
    if (!active || active.settled) return;
    active.settled = true;
    this.cleanupActive(active);
    this.active = null;
    active.resolve(value);
  }

  rejectActive(error) {
    const active = this.active;
    if (!active || active.settled) return;
    active.settled = true;
    this.cleanupActive(active);
    this.active = null;
    active.reject(error instanceof Error ? error : new Error(String(error)));
  }

  cleanupActive(active) {
    if (active.watchdog) clearTimeout(active.watchdog);
    if (active.errorTimer) clearTimeout(active.errorTimer);
    if (active.signal && active.abortHandler) {
      active.signal.removeEventListener('abort', active.abortHandler);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.unsubscribe) this.unsubscribe();
    if (this.active) this.rejectActive(new TurnMonitorAborted());
  }
}

function createSessionTurnMonitor(options) {
  return new SessionTurnMonitor(options);
}

module.exports = {
  SessionTurnMonitor,
  TurnMonitorTimeout,
  SessionTurnError,
  TurnMonitorAborted,
  createSessionTurnMonitor,
  normalizeEvent,
  eventProperties,
  eventSessionId,
  isTerminalAssistant,
  terminalMessageIds,
  newestTerminal,
  sessionStatusOf,
};
