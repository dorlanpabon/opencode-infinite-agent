import path from 'node:path';
import type {
  OpenCodeModelCatalog,
  OpenCodeSessionStatus,
  OpenCodeSessionSummary,
  SessionConnectionInput,
} from './contracts.js';
import { loadOpenCodeModelCatalog } from './model-catalog.js';

interface ServerHandle {
  base: string;
  owned: boolean;
  proc: unknown;
}

interface EventStream {
  ready: Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  abort(): void;
}

interface ServerModule {
  findAvailableLoopbackPort(): Promise<number>;
  ensureServer(cfg: Record<string, unknown>, log: CatalogLogger, options: { signal: AbortSignal }): Promise<ServerHandle>;
  stopServer(handle: ServerHandle): Promise<void>;
  request(base: string, method: string, pathname: string, body: unknown, options: Record<string, unknown>): Promise<unknown>;
  startEventStream(options: Record<string, unknown>): EventStream;
}

interface ConfigModule {
  loadConfig(input: Record<string, unknown>): Record<string, unknown>;
}

interface CatalogLogger {
  banner(message: string): void;
  ok(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  err(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

interface CatalogConnection {
  controller: AbortController;
  eventStream: EventStream;
  handle: ServerHandle;
  input: SessionConnectionInput;
  key: string;
  unsubscribe: () => void;
}

export interface SessionCatalogDependencies {
  server: ServerModule;
  config: ConfigModule;
}

const defaultDependencies: SessionCatalogDependencies = {
  server: require('../server.js') as ServerModule,
  config: require('../config.js') as ConfigModule,
};

const SESSION_ID = /^ses_[A-Za-z0-9]+$/u;
const RECONCILE_EVENTS = new Set([
  'server.connected',
  'session.created',
  'session.updated',
  'session.deleted',
  'session.status',
  'session.idle',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function connectionKey(input: SessionConnectionInput): string {
  const workspace = path.resolve(input.workspace);
  const normalized = process.platform === 'win32' ? workspace.toLowerCase() : workspace;
  return JSON.stringify([normalized, input.binary, input.attach, input.sessionRef]);
}

function timestamp(value: unknown): string {
  const numeric = typeof value === 'number' ? value : Number(value);
  const date = Number.isFinite(numeric) ? new Date(numeric) : new Date(0);
  return date.toISOString();
}

function eventType(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const event = isRecord(value.payload) ? value.payload : value;
  return typeof event.type === 'string' ? event.type : null;
}

function statusOf(value: unknown): { status: OpenCodeSessionStatus; retryMessage: string | null } {
  if (!isRecord(value) || (value.type !== 'busy' && value.type !== 'retry')) {
    return { status: 'idle', retryMessage: null };
  }
  return {
    status: value.type,
    retryMessage: value.type === 'retry' && typeof value.message === 'string' ? value.message.slice(0, 2_000) : null,
  };
}

function unwrapSessions(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.data)) return value.data;
  return [];
}

function noOpLogger(onLog: (level: 'debug' | 'info' | 'warn', message: string) => void): CatalogLogger {
  return {
    banner: (message) => onLog('info', message),
    ok: (message) => onLog('info', message),
    info: (message) => onLog('info', message),
    warn: (message) => onLog('warn', message),
    err: (message) => onLog('warn', message),
    error: (message) => onLog('warn', message),
    debug: (message) => onLog('debug', message),
  };
}

export class OpenCodeSessionCatalog {
  private connection: CatalogConnection | null = null;
  private connectPromise: Promise<CatalogConnection> | null = null;
  private connectKey: string | null = null;
  private openingController: AbortController | null = null;
  private lifecycle = 0;
  private disposed = false;
  private reconcilePromise: Promise<OpenCodeSessionSummary[]> | null = null;
  private reconcileAgain = false;
  private listener: ((sessions: OpenCodeSessionSummary[]) => void) | null = null;
  private snapshot: OpenCodeSessionSummary[] = [];

  constructor(
    private readonly onLog: (level: 'debug' | 'info' | 'warn', message: string) => void = () => undefined,
    private readonly dependencies: SessionCatalogDependencies = defaultDependencies,
  ) {}

  setListener(listener: (sessions: OpenCodeSessionSummary[]) => void): void {
    this.listener = listener;
  }

  matches(input: SessionConnectionInput): boolean {
    return this.connection?.key === connectionKey(input);
  }

  async connect(input: SessionConnectionInput): Promise<{ base: string; sessions: OpenCodeSessionSummary[] }> {
    if (this.disposed) throw new Error('El catálogo de sesiones está cerrado.');
    const key = connectionKey(input);
    if (this.connection?.key === key) {
      return { base: this.connection.handle.base, sessions: await this.reconcile() };
    }
    const pending = this.connectPromise;
    if (pending && this.connectKey === key) {
      const connection = await pending;
      return { base: connection.handle.base, sessions: await this.reconcile() };
    }

    const lifecycle = ++this.lifecycle;
    if (pending) {
      this.openingController?.abort();
      await pending.catch(() => undefined);
      if (this.disposed || lifecycle !== this.lifecycle) {
        throw new Error('La conexión del catálogo fue cancelada.');
      }
    }

    const controller = new AbortController();
    const opening = (async () => {
      await this.releaseConnection();
      if (this.disposed || lifecycle !== this.lifecycle || controller.signal.aborted) {
        throw new Error('La conexión del catálogo fue cancelada.');
      }
      return this.open(input, key, controller, lifecycle);
    })();
    this.connectKey = key;
    this.openingController = controller;
    this.connectPromise = opening;
    try {
      const connection = await opening;
      return { base: connection.handle.base, sessions: await this.reconcile() };
    } finally {
      if (this.connectPromise === opening) {
        this.connectPromise = null;
        this.connectKey = null;
        this.openingController = null;
      }
    }
  }

  async reconcile(): Promise<OpenCodeSessionSummary[]> {
    if (!this.connection) throw new Error('El catálogo de sesiones no está conectado.');
    if (this.reconcilePromise) {
      this.reconcileAgain = true;
      return this.reconcilePromise;
    }
    this.reconcilePromise = (async () => {
      do {
        this.reconcileAgain = false;
        const current = this.connection;
        if (!current) throw new Error('El catálogo de sesiones se desconectó.');
        const requestOptions = { directory: current.input.workspace, timeoutMs: 10_000, signal: current.controller.signal };
        const [sessionsValue, statusesValue] = await Promise.all([
          this.dependencies.server.request(current.handle.base, 'GET', '/session', null, requestOptions),
          this.dependencies.server.request(current.handle.base, 'GET', '/session/status', null, requestOptions),
        ]);
        if (this.connection !== current) continue;
        const statuses = isRecord(statusesValue) ? statusesValue : {};
        const next: OpenCodeSessionSummary[] = [];
        for (const raw of unwrapSessions(sessionsValue)) {
          if (!isRecord(raw) || typeof raw.id !== 'string' || !SESSION_ID.test(raw.id)) continue;
          const time = isRecord(raw.time) ? raw.time : {};
          const sessionStatus = statusOf(statuses[raw.id]);
          next.push({
            id: raw.id,
            title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.slice(0, 512) : raw.id,
            workspace: typeof raw.directory === 'string' && path.isAbsolute(raw.directory)
              ? raw.directory
              : current.input.workspace,
            createdAt: timestamp(time.created),
            updatedAt: timestamp(time.updated ?? time.created),
            status: sessionStatus.status,
            retryMessage: sessionStatus.retryMessage,
            continuous: false,
            runId: null,
          });
        }
        next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        this.snapshot = next;
        this.listener?.(this.current());
      } while (this.reconcileAgain && this.connection);
      return this.current();
    })();
    try {
      return await this.reconcilePromise;
    } finally {
      this.reconcilePromise = null;
    }
  }

  current(): OpenCodeSessionSummary[] {
    return this.snapshot.map((session) => ({ ...session }));
  }

  async models(): Promise<OpenCodeModelCatalog> {
    const current = this.connection;
    if (!current) throw new Error('El catálogo de sesiones no está conectado.');
    return loadOpenCodeModelCatalog(
      this.dependencies.server,
      current.handle.base,
      current.input.workspace,
      current.controller.signal,
    );
  }

  async close(): Promise<void> {
    this.disposed = true;
    this.lifecycle++;
    const pending = this.connectPromise;
    this.openingController?.abort();
    if (pending) await pending.catch(() => undefined);
    await this.releaseConnection();
    if (this.connectPromise === pending) {
      this.connectPromise = null;
      this.connectKey = null;
      this.openingController = null;
    }
  }

  private async releaseConnection(): Promise<void> {
    const connection = this.connection;
    const hadSnapshot = this.snapshot.length > 0;
    this.connection = null;
    this.snapshot = [];
    if (connection || hadSnapshot) this.listener?.([]);
    if (!connection) return;
    connection.unsubscribe();
    connection.eventStream.abort();
    connection.controller.abort();
    if (connection.handle.owned) await this.dependencies.server.stopServer(connection.handle);
  }

  private async open(
    input: SessionConnectionInput,
    key: string,
    controller: AbortController,
    lifecycle: number,
  ): Promise<CatalogConnection> {
    let handle: ServerHandle | null = null;
    let eventStream: EventStream | null = null;
    let unsubscribe: () => void = () => undefined;
    let connection: CatalogConnection | null = null;
    try {
      const cfg = this.dependencies.config.loadConfig({
        dir: input.workspace,
        opencodeBin: input.binary,
        attach: input.attach,
        keepServer: true,
        noDiscover: true,
      });
      if (input.attach === null) {
        cfg.discover = false;
        cfg.port = await this.dependencies.server.findAvailableLoopbackPort();
        cfg.base = `http://127.0.0.1:${String(cfg.port)}`;
      }
      handle = await this.dependencies.server.ensureServer(cfg, noOpLogger(this.onLog), { signal: controller.signal });
      if (this.disposed || lifecycle !== this.lifecycle || controller.signal.aborted) {
        throw new Error('La conexión del catálogo fue cancelada.');
      }
      eventStream = this.dependencies.server.startEventStream({
        base: handle.base,
        directory: input.workspace,
        signal: controller.signal,
        debug: (message: string) => this.onLog('debug', message),
      });
      connection = { controller, eventStream, handle, input, key, unsubscribe };
      this.connection = connection;
      unsubscribe = eventStream.subscribe((event) => {
        const type = eventType(event);
        if (!type || !RECONCILE_EVENTS.has(type)) return;
        void this.reconcile().catch((error: unknown) => {
          this.onLog('debug', `Reconciliación de sesiones: ${error instanceof Error ? error.message : String(error)}`);
        });
      });
      connection.unsubscribe = unsubscribe;
      await eventStream.ready;
      if (this.disposed || lifecycle !== this.lifecycle || controller.signal.aborted || this.connection !== connection) {
        throw new Error('La conexión del catálogo fue cancelada.');
      }
      return connection;
    } catch (error) {
      unsubscribe();
      eventStream?.abort();
      controller.abort();
      if (connection && this.connection === connection) this.connection = null;
      this.snapshot = [];
      if (handle?.owned) await this.dependencies.server.stopServer(handle);
      throw error;
    }
  }
}
