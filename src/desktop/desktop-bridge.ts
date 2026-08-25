import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  OpenCodeModelCatalog,
  OpenCodeSessionStatus,
  OpenCodeSessionSummary,
  SessionConnectionInput,
} from './contracts.js';
import { parseOpenCodeModelCatalog } from './model-catalog.js';

const { parseSessionRef } = require('../session-ref.js') as {
  parseSessionRef(input: unknown): string | null;
};

interface EventStream {
  ready: Promise<void>;
  subscribe(listener: (event: unknown) => void): () => void;
  abort(): void;
}

interface ServerModule {
  request(base: string, method: string, pathname: string, body: unknown, options: Record<string, unknown>): Promise<unknown>;
  startEventStream(options: Record<string, unknown>): EventStream;
  registerDesktopBridge(base: string, token: string): void;
  unregisterDesktopBridge(base: string): void;
}

interface DesktopBridgeDescriptor {
  schemaVersion: 1;
  bridgeVersion: number;
  buildId: string;
  bridgeId: string;
  endpoint: string;
  token: string;
  pid: number;
  projectID: string;
  directory: string;
  worktree: string;
  startedAt: string;
}

interface ActiveBridge {
  controller: AbortController;
  descriptor: DesktopBridgeDescriptor;
  eventStream: EventStream;
  unsubscribe: () => void;
}

interface DesktopBridgeDependencies {
  server: ServerModule;
  registryDirectory(): string;
  pluginSource: string;
  pluginDestination: string;
  connectTimeoutMs: number;
  processExists(pid: number): boolean;
}

interface RegistryEntry {
  descriptor: DesktopBridgeDescriptor;
  file: string;
}

const serverModule = require('../server.js') as ServerModule;
const SESSION_ID = /^ses_[A-Za-z0-9]+$/u;
const PLUGIN_MARKER = Buffer.from('// opencode-infinite-agent:desktop-bridge\n');
const LEGACY_PLUGIN_HASHES = new Set(['fd43559cf1f06118dd3300c2dfeb20b85ea24fcf14ec1261b54350f8b4197d3f']);
const REQUIRED_BRIDGE_VERSION = 4;
const BRIDGE_FAILURE_LIMIT = 3;
const RECONCILE_EVENTS = new Set([
  'server.connected',
  'session.created',
  'session.updated',
  'session.deleted',
  'session.status',
  'session.idle',
]);

function stateDirectory(): string {
  const configured = process.env.OPENCODE_INFINITE_STATE_DIR;
  if (configured && path.isAbsolute(configured)) return path.join(configured, 'bridges');
  return path.join(os.homedir(), '.opencode-infinite', 'bridges');
}

function configDirectory(): string {
  const explicit = process.env.OPENCODE_CONFIG_DIR;
  if (explicit && path.isAbsolute(explicit)) return path.join(explicit, 'plugins');
  const configured = process.env.XDG_CONFIG_HOME;
  const root = configured && path.isAbsolute(configured) ? configured : path.join(os.homedir(), '.config');
  return path.join(root, 'opencode', 'plugins');
}

const defaultDependencies: DesktopBridgeDependencies = {
  server: serverModule,
  registryDirectory: stateDirectory,
  pluginSource: path.join(__dirname, 'plugin', 'opencode-infinite-bridge.js'),
  pluginDestination: path.join(configDirectory(), 'opencode-infinite-bridge.js'),
  connectTimeoutMs: 15_000,
  processExists(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return isRecord(error) && error.code === 'EPERM';
    }
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorStatus(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const status = Number(value.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
}

function isConfigInvalidFailure(value: unknown): boolean {
  const name = isRecord(value) && typeof value.name === 'string' ? value.name : '';
  const message = value instanceof Error
    ? value.message
    : isRecord(value) && typeof value.message === 'string' ? value.message : '';
  return name === 'ConfigInvalidError'
    || /ConfigInvalidError|configuraci[oó]n(?: de OpenCode)? inv[aá]lida|configuration (?:is )?invalid/iu.test(message);
}

function sanitizedBridgeFailure(value: unknown): Error {
  const status = errorStatus(value);
  const source = value instanceof Error
    ? value.message
    : isRecord(value) && typeof value.message === 'string' ? value.message : 'OpenCode Desktop rechazó la sesión solicitada.';
  const message = source
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/(authorization\s*:\s*(?:basic|bearer)\s+)[^\s,;]+/giu, '$1[REDACTED]')
    .replace(/((?:password|token|secret|api[_-]?key)"?\s*[=:]\s*"?)[^\s,;"}]+/giu, '$1[REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/gu, '[REDACTED]')
    .trim()
    .slice(0, 2_000) || 'OpenCode Desktop rechazó la sesión solicitada.';
  const failure = new Error(message) as Error & { status?: number };
  failure.name = isConfigInvalidFailure(value) ? 'ConfigInvalidError' : 'OpenCodeDesktopError';
  if (status !== null) failure.status = status;
  return failure;
}

function preferredBridgeFailure(attempts: PromiseSettledResult<unknown>[]): Error | null {
  const rejections = attempts.flatMap((attempt) => attempt.status === 'rejected' ? [attempt.reason] : []);
  const selected = rejections.find(isConfigInvalidFailure)
    ?? rejections.find((reason) => {
      const status = errorStatus(reason);
      return status !== null && status >= 400 && status < 500;
    });
  return selected === undefined ? null : sanitizedBridgeFailure(selected);
}

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function eventType(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const payload = isRecord(value.payload) ? value.payload : value;
  return typeof payload.type === 'string' ? payload.type : null;
}

function sessionIdFromReference(value: string | null): string | null {
  return parseSessionRef(value);
}

function connectionKey(input: SessionConnectionInput): string {
  return JSON.stringify([
    normalizedPath(input.workspace),
    input.attach ?? '',
    input.binary ? normalizedPath(input.binary) : '',
    input.sessionRef ?? '',
  ]);
}

async function waitForStream(stream: EventStream, timeoutMs: number, controller: AbortController): Promise<void> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      stream.ready,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error('OpenCode Desktop no abrió el stream de eventos a tiempo.'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function timestamp(value: unknown): string {
  const numeric = typeof value === 'number' ? value : Number(value);
  return new Date(Number.isFinite(numeric) ? numeric : 0).toISOString();
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
  return isRecord(value) && Array.isArray(value.data) ? value.data : [];
}

function parseDescriptor(value: unknown): DesktopBridgeDescriptor | null {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.bridgeVersion) || Number(value.bridgeVersion) < 1
    || typeof value.buildId !== 'string' || !/^[a-f0-9]{64}$/u.test(value.buildId)
    || typeof value.bridgeId !== 'string' || !/^[a-f0-9]{32}$/u.test(value.bridgeId)
    || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/u.test(value.token)
    || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1
    || typeof value.projectID !== 'string' || value.projectID.length === 0 || value.projectID.length > 512
    || typeof value.directory !== 'string' || !path.isAbsolute(value.directory)
    || typeof value.worktree !== 'string' || !path.isAbsolute(value.worktree)
    || typeof value.startedAt !== 'string' || !Number.isFinite(Date.parse(value.startedAt))
    || typeof value.endpoint !== 'string') return null;
  let endpoint: URL;
  try {
    endpoint = new URL(value.endpoint);
  } catch {
    return null;
  }
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1'
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.pathname !== '/') return null;
  return {
    schemaVersion: 1,
    bridgeVersion: Number(value.bridgeVersion),
    buildId: value.buildId,
    bridgeId: value.bridgeId,
    endpoint: endpoint.origin,
    token: value.token,
    pid: Number(value.pid),
    projectID: value.projectID,
    directory: value.directory,
    worktree: value.worktree,
    startedAt: value.startedAt,
  };
}

function explicitSessionWorkspace(raw: Record<string, unknown>): string | null {
  return typeof raw.directory === 'string' && path.isAbsolute(raw.directory) ? raw.directory : null;
}

function sessionWorkspace(raw: Record<string, unknown>, fallbackWorkspace: string): string | null {
  const explicit = explicitSessionWorkspace(raw);
  return raw.projectID === 'global' ? explicit : explicit ?? fallbackWorkspace;
}

function summaryOf(raw: Record<string, unknown>, status: unknown, fallbackWorkspace: string): OpenCodeSessionSummary | null {
  if (typeof raw.id !== 'string' || !SESSION_ID.test(raw.id)) return null;
  const workspace = sessionWorkspace(raw, fallbackWorkspace);
  if (!workspace) return null;
  const time = isRecord(raw.time) ? raw.time : {};
  const sessionStatus = statusOf(status);
  return {
    id: raw.id,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.slice(0, 512) : raw.id,
    workspace,
    createdAt: timestamp(time.created),
    updatedAt: timestamp(time.updated ?? time.created),
    status: sessionStatus.status,
    retryMessage: sessionStatus.retryMessage,
    continuous: false,
    runId: null,
  };
}

function routeDescriptor(
  descriptor: DesktopBridgeDescriptor,
  raw: Record<string, unknown>,
  workspace: string,
): DesktopBridgeDescriptor {
  const project = isRecord(raw.project) ? raw.project : null;
  const worktree = project && typeof project.worktree === 'string' && path.isAbsolute(project.worktree)
    ? project.worktree
    : workspace;
  return {
    ...descriptor,
    projectID: typeof raw.projectID === 'string' && raw.projectID ? raw.projectID : descriptor.projectID,
    directory: workspace,
    worktree,
  };
}

function ownsSession(
  descriptor: DesktopBridgeDescriptor,
  raw: Record<string, unknown>,
  workspace: string,
): boolean {
  if (typeof raw.projectID !== 'string' || raw.projectID !== descriptor.projectID) return false;
  if (raw.projectID !== 'global') return true;
  const explicit = explicitSessionWorkspace(raw);
  return explicit !== null
    && normalizedPath(workspace) === normalizedPath(explicit)
    && normalizedPath(explicit) === normalizedPath(descriptor.directory);
}

async function installPlugin(dependencies: DesktopBridgeDependencies): Promise<{
  status: 'current' | 'installed' | 'updated';
  buildId: string;
}> {
  const source = await readFile(dependencies.pluginSource);
  const buildId = createHash('sha256').update(source).digest('hex');
  let existing: Buffer | null = null;
  try {
    existing = await readFile(dependencies.pluginDestination);
  } catch (error) {
    if (!isRecord(error) || error.code !== 'ENOENT') throw error;
  }
  if (existing?.equals(source)) return { status: 'current', buildId };
  const legacyHash = existing ? createHash('sha256').update(existing).digest('hex') : null;
  if (existing && !existing.subarray(0, PLUGIN_MARKER.length).equals(PLUGIN_MARKER)
    && (!legacyHash || !LEGACY_PLUGIN_HASHES.has(legacyHash))) {
    throw new Error(`No se sobrescribió el plugin existente: ${dependencies.pluginDestination}`);
  }
  const destinationDirectory = path.dirname(dependencies.pluginDestination);
  await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
  const temporary = path.join(destinationDirectory, `.opencode-infinite-${randomBytes(8).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, source, { flag: 'wx', mode: 0o600 });
    await rename(temporary, dependencies.pluginDestination);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  await chmod(dependencies.pluginDestination, 0o600).catch(() => undefined);
  return { status: existing ? 'updated' : 'installed', buildId };
}

export class OpenCodeDesktopBridgeCatalog {
  private active: ActiveBridge[] = [];
  private endpointBySession = new Map<string, DesktopBridgeDescriptor>();
  private listener: ((sessions: OpenCodeSessionSummary[]) => void) | null = null;
  private snapshot: OpenCodeSessionSummary[] = [];
  private reconcilePromise: Promise<OpenCodeSessionSummary[]> | null = null;
  private reconcileAgain = false;
  private sessionReference: string | null = null;
  private connectQueue: Promise<void> = Promise.resolve();
  private pendingConnection: { key: string; promise: Promise<{ sessions: OpenCodeSessionSummary[] }> } | null = null;
  private openingControllers = new Set<AbortController>();
  private bridgeFailures = new Map<string, number>();
  private authenticatedEndpoints = new Set<string>();
  private requestedWorkspace: string | null = null;
  private disposed = false;

  constructor(
    private readonly onLog: (level: 'debug' | 'info' | 'warn', message: string) => void = () => undefined,
    private readonly dependencies: DesktopBridgeDependencies = defaultDependencies,
  ) {}

  setListener(listener: (sessions: OpenCodeSessionSummary[]) => void): void {
    this.listener = listener;
  }

  async connect(input: SessionConnectionInput): Promise<{ sessions: OpenCodeSessionSummary[] }> {
    if (this.disposed) throw new Error('El catálogo de OpenCode Desktop está cerrado.');
    const key = connectionKey(input);
    if (this.pendingConnection?.key === key) return this.pendingConnection.promise;

    const promise = this.connectQueue.then(() => this.open(input));
    this.connectQueue = promise.then(() => undefined, () => undefined);
    const pending = { key, promise };
    this.pendingConnection = pending;
    try {
      return await promise;
    } finally {
      if (this.pendingConnection === pending) this.pendingConnection = null;
    }
  }

  private async open(input: SessionConnectionInput): Promise<{ sessions: OpenCodeSessionSummary[] }> {
    if (this.disposed) throw new Error('El catálogo de OpenCode Desktop está cerrado.');
    const sessionReference = sessionIdFromReference(input.sessionRef);
    if (input.sessionRef !== null && !sessionReference) {
      throw new TypeError('La referencia de sesión OpenCode no es válida.');
    }
    await this.release();
    this.sessionReference = sessionReference;
    this.requestedWorkspace = path.resolve(input.workspace);
    const installation = await installPlugin(this.dependencies);
    const descriptors = await this.discover(installation.buildId);
    if (descriptors.length === 0) {
      const action = installation.status === 'current' ? 'La integración está instalada pero no está cargada.' : 'Integración instalada o actualizada correctamente.';
      throw new Error(`${action} Cierra y vuelve a abrir OpenCode Desktop, abre la sesión y pulsa «Conectar» otra vez.`);
    }
    if (this.disposed) {
      for (const descriptor of descriptors) {
        this.unregisterBridge(descriptor.endpoint);
      }
      throw new Error('El catálogo de OpenCode Desktop está cerrado.');
    }

    const opening: ActiveBridge[] = [];
    const active: ActiveBridge[] = [];
    try {
      for (const descriptor of descriptors) {
        const controller = new AbortController();
        this.openingControllers.add(controller);
        try {
          const eventStream = this.dependencies.server.startEventStream({
            base: descriptor.endpoint,
            directory: descriptor.directory,
            signal: controller.signal,
            debug: (message: string) => this.onLog('debug', message),
          });
          opening.push({ controller, descriptor, eventStream, unsubscribe: () => undefined });
        } catch (error) {
          this.openingControllers.delete(controller);
          controller.abort();
          throw error;
        }
      }
      let firstStreamFailure: unknown = null;
      const connected = await Promise.all(opening.map(async (endpoint) => {
        try {
          await waitForStream(endpoint.eventStream, this.dependencies.connectTimeoutMs, endpoint.controller);
          if (this.disposed || endpoint.controller.signal.aborted) return null;
          endpoint.unsubscribe = endpoint.eventStream.subscribe((event) => {
            const type = eventType(event);
            if (!type || !RECONCILE_EVENTS.has(type)) return;
            void this.reconcile().catch((error: unknown) => {
              this.onLog('debug', `Reconciliación Desktop: ${error instanceof Error ? error.message : String(error)}`);
            });
          });
          return endpoint;
        } catch (error) {
          firstStreamFailure ??= error;
          this.onLog('debug', `Stream Desktop descartado: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        } finally {
          this.openingControllers.delete(endpoint.controller);
        }
      }));
      active.push(...connected.filter((endpoint): endpoint is ActiveBridge => endpoint !== null));
      for (const endpoint of opening) {
        if (active.includes(endpoint)) continue;
        endpoint.unsubscribe();
        endpoint.eventStream.abort();
        this.unregisterBridge(endpoint.descriptor.endpoint);
      }
      if (this.disposed) throw new Error('La conexión con OpenCode Desktop fue cancelada.');
      if (active.length === 0) {
        if (firstStreamFailure instanceof Error) throw firstStreamFailure;
        throw new Error('Ningún sidecar de OpenCode Desktop abrió su stream de eventos.');
      }
      this.active = active;
      const sessions = await this.reconcile();
      return { sessions };
    } catch (error) {
      for (const endpoint of opening) {
        this.openingControllers.delete(endpoint.controller);
        endpoint.unsubscribe();
        endpoint.eventStream.abort();
      }
      for (const descriptor of descriptors) this.unregisterBridge(descriptor.endpoint);
      if (this.active === active) this.active = [];
      throw error;
    }
  }

  current(): OpenCodeSessionSummary[] {
    return this.snapshot.map((session) => ({ ...session }));
  }

  get connected(): boolean {
    return this.active.length > 0;
  }

  endpointForSession(sessionId: string): DesktopBridgeDescriptor {
    const endpoint = this.endpointBySession.get(sessionId);
    if (!endpoint) throw new Error('La sesión ya no está disponible en OpenCode Desktop. Vuelve a conectar el catálogo.');
    return { ...endpoint };
  }

  async models(workspace?: string): Promise<OpenCodeModelCatalog> {
    const requestedWorkspace = workspace ? path.resolve(workspace) : this.requestedWorkspace;
    if (!requestedWorkspace || this.active.length === 0) {
      throw new Error('El catálogo de OpenCode Desktop no está conectado.');
    }
    const endpoint = this.active.find(({ descriptor }) => normalizedPath(descriptor.directory) === normalizedPath(requestedWorkspace))
      ?? this.active[0];
    if (!endpoint) throw new Error('OpenCode Desktop no expone un sidecar activo para este workspace.');
    const value = await this.dependencies.server.request(
      endpoint.descriptor.endpoint,
      'GET',
      '/models',
      null,
      { directory: requestedWorkspace, timeoutMs: 15_000 },
    );
    return parseOpenCodeModelCatalog(value);
  }

  async reconcile(): Promise<OpenCodeSessionSummary[]> {
    if (this.active.length === 0) throw new Error('No hay puentes activos de OpenCode Desktop.');
    if (this.reconcilePromise) {
      this.reconcileAgain = true;
      return this.reconcilePromise;
    }
    this.reconcilePromise = (async () => {
      do {
        this.reconcileAgain = false;
        const candidates = new Map<string, { summary: OpenCodeSessionSummary; endpoint: DesktopBridgeDescriptor; score: number }>();
        const active = [...this.active];
        const settled = await Promise.allSettled(active.map(async ({ descriptor }) => {
          const options = { directory: descriptor.directory, timeoutMs: 10_000 };
          const [sessions, statuses] = await Promise.all([
            this.dependencies.server.request(descriptor.endpoint, 'GET', '/session', null, options),
            this.dependencies.server.request(descriptor.endpoint, 'GET', '/session/status', null, options),
          ]);
          return { descriptor, sessions, statuses: isRecord(statuses) ? statuses : {} };
        }));
        const results = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
        const failed = new Set<string>();
        const retainedFailures = new Set<string>();
        for (const [index, result] of settled.entries()) {
          if (result.status === 'rejected') {
            const endpoint = active[index];
            if (endpoint) {
              const bridgeId = endpoint.descriptor.bridgeId;
              const failures = (this.bridgeFailures.get(bridgeId) ?? 0) + 1;
              this.bridgeFailures.set(bridgeId, failures);
              if (failures >= BRIDGE_FAILURE_LIMIT) failed.add(bridgeId);
              else retainedFailures.add(bridgeId);
            }
            this.onLog('debug', `Sidecar omitido durante reconciliación: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
          } else {
            const endpoint = active[index];
            if (endpoint) this.bridgeFailures.delete(endpoint.descriptor.bridgeId);
          }
        }
        for (const endpoint of active) {
          if (!failed.has(endpoint.descriptor.bridgeId)) continue;
          this.bridgeFailures.delete(endpoint.descriptor.bridgeId);
          endpoint.unsubscribe();
          endpoint.eventStream.abort();
        }
        if (failed.size > 0) {
          this.active = this.active.filter((endpoint) => !failed.has(endpoint.descriptor.bridgeId));
        }
        if (results.length === 0) {
          const failure = preferredBridgeFailure(settled);
          if (failure) throw failure;
          if (this.snapshot.length > 0 && this.active.length > 0) continue;
          this.endpointBySession.clear();
          this.snapshot = [];
          this.listener?.([]);
          throw new Error('Ningún sidecar de OpenCode Desktop respondió al catálogo.');
        }

        for (const summary of this.snapshot) {
          const endpoint = this.endpointBySession.get(summary.id);
          if (endpoint && retainedFailures.has(endpoint.bridgeId)) {
            candidates.set(summary.id, { summary, endpoint, score: 0 });
          }
        }

        for (const result of results) {
          for (const raw of unwrapSessions(result.sessions)) {
            if (!isRecord(raw)) continue;
            const summary = summaryOf(raw, typeof raw.id === 'string' ? result.statuses[raw.id] : null, result.descriptor.directory);
            if (!summary) continue;
            if (!ownsSession(result.descriptor, raw, summary.workspace)) continue;
            const endpoint = routeDescriptor(result.descriptor, raw, summary.workspace);
            const score = 2
              + (normalizedPath(summary.workspace) === normalizedPath(result.descriptor.directory) ? 1 : 0)
              + (summary.status === 'idle' ? 0 : 4);
            const previous = candidates.get(summary.id);
            if (!previous || score > previous.score) candidates.set(summary.id, { summary, endpoint, score });
          }
        }

        if (this.sessionReference && !candidates.has(this.sessionReference)) {
          const adopted = await this.adopt(this.sessionReference, results);
          if (adopted) candidates.set(adopted.summary.id, adopted);
        }

        this.endpointBySession = new Map([...candidates].map(([id, value]) => [id, value.endpoint]));
        this.snapshot = [...candidates.values()].map(({ summary }) => summary)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        this.listener?.(this.current());
      } while (this.reconcileAgain && this.active.length > 0);
      return this.current();
    })();
    try {
      return await this.reconcilePromise;
    } finally {
      this.reconcilePromise = null;
    }
  }

  async close(): Promise<void> {
    this.disposed = true;
    for (const controller of this.openingControllers) controller.abort();
    await this.release();
    await this.connectQueue;
  }

  private async adopt(
    sessionId: string,
    results: Array<{ descriptor: DesktopBridgeDescriptor; statuses: Record<string, unknown> }>,
  ): Promise<{ summary: OpenCodeSessionSummary; endpoint: DesktopBridgeDescriptor; score: number } | null> {
    const requestedWorkspace = this.requestedWorkspace;
    if (!requestedWorkspace) return null;
    const attempts = await Promise.allSettled(results.map(async ({ descriptor, statuses }) => {
      const raw = await this.dependencies.server.request(
        descriptor.endpoint,
        'GET',
        `/session/${sessionId}`,
        null,
        { directory: requestedWorkspace, timeoutMs: 5_000 },
      );
      if (!isRecord(raw)) return null;
      const scopedStatuses = normalizedPath(requestedWorkspace) === normalizedPath(descriptor.directory)
        ? statuses
        : await this.dependencies.server.request(
          descriptor.endpoint,
          'GET',
          '/session/status',
          null,
          { directory: requestedWorkspace, timeoutMs: 5_000 },
        );
      const summary = summaryOf(
        raw,
        isRecord(scopedStatuses) ? scopedStatuses[sessionId] : null,
        requestedWorkspace,
      );
      if (!summary) return null;
      if (normalizedPath(summary.workspace) !== normalizedPath(requestedWorkspace)) return null;
      if (raw.projectID !== 'global' && !ownsSession(descriptor, raw, summary.workspace)) return null;
      const endpoint = routeDescriptor(descriptor, raw, summary.workspace);
      const score = 2
        + (normalizedPath(summary.workspace) === normalizedPath(descriptor.directory) ? 1 : 0)
        + (summary.status === 'idle' ? 0 : 4);
      return { summary, endpoint, score };
    }));
    const matches = attempts.flatMap((attempt) => attempt.status === 'fulfilled' && attempt.value ? [attempt.value] : []);
    matches.sort((a, b) => b.score - a.score);
    if (matches[0]) return matches[0];
    const failure = preferredBridgeFailure(attempts);
    if (failure) throw failure;
    return null;
  }

  private async discover(buildId: string): Promise<DesktopBridgeDescriptor[]> {
    const root = this.dependencies.registryDirectory();
    let names: string[];
    try {
      names = (await readdir(root)).filter((name) => name.endsWith('.json'));
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') return [];
      throw error;
    }
    const canonicalRoot = await realpath(root);
    const parsed = await Promise.all(names.map(async (name): Promise<RegistryEntry | null> => {
      const candidate = path.join(root, name);
      try {
        const info = await lstat(candidate);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) return null;
        const canonical = await realpath(candidate);
        if (normalizedPath(path.dirname(canonical)) !== normalizedPath(canonicalRoot)) return null;
        const descriptor = parseDescriptor(JSON.parse(await readFile(canonical, 'utf8')));
        if (!descriptor) return null;
        if (!this.dependencies.processExists(descriptor.pid)) {
          await unlink(canonical).catch(() => undefined);
          return null;
        }
        return { descriptor, file: canonical };
      } catch {
        return null;
      }
    }));
    const groups = new Map<string, RegistryEntry[]>();
    for (const entry of parsed) {
      if (!entry || entry.descriptor.bridgeVersion < REQUIRED_BRIDGE_VERSION
        || entry.descriptor.buildId !== buildId) continue;
      const group = groups.get(entry.descriptor.endpoint) ?? [];
      group.push(entry);
      groups.set(entry.descriptor.endpoint, group);
    }
    const probed = await Promise.all([...groups.values()].map(async (group) => {
      for (const entry of group.sort((a, b) => b.descriptor.startedAt.localeCompare(a.descriptor.startedAt))) {
        const { descriptor } = entry;
        this.registerBridge(descriptor);
        try {
          const health = await this.dependencies.server.request(
            descriptor.endpoint,
            'GET',
            '/global/health',
            null,
            { timeoutMs: 1_500 },
          );
          if (isRecord(health) && health.healthy === true && health.bridgeId === descriptor.bridgeId
            && health.buildId === descriptor.buildId) return descriptor;
        } catch {}
        this.unregisterBridge(descriptor.endpoint);
        if (!this.dependencies.processExists(descriptor.pid)) {
          await unlink(entry.file).catch(() => undefined);
        }
      }
      return null;
    }));
    const unique = new Map<string, DesktopBridgeDescriptor>();
    for (const descriptor of probed) {
      if (descriptor) unique.set(descriptor.bridgeId, descriptor);
    }
    const descriptors = [...unique.values()];
    for (const descriptor of descriptors) {
      this.registerBridge(descriptor);
    }
    return descriptors;
  }

  private async release(): Promise<void> {
    const active = this.active;
    this.active = [];
    for (const endpoint of active) {
      endpoint.unsubscribe();
      endpoint.eventStream.abort();
    }
    const pendingReconcile = this.reconcilePromise;
    if (pendingReconcile) await pendingReconcile.catch(() => undefined);
    for (const endpoint of this.authenticatedEndpoints) {
      this.dependencies.server.unregisterDesktopBridge(endpoint);
    }
    this.authenticatedEndpoints.clear();
    this.snapshot = [];
    this.endpointBySession.clear();
    this.bridgeFailures.clear();
    if (active.length > 0) this.listener?.([]);
  }

  private registerBridge(descriptor: DesktopBridgeDescriptor): void {
    this.dependencies.server.registerDesktopBridge(descriptor.endpoint, descriptor.token);
    this.authenticatedEndpoints.add(descriptor.endpoint);
  }

  private unregisterBridge(endpoint: string): void {
    this.dependencies.server.unregisterDesktopBridge(endpoint);
    this.authenticatedEndpoints.delete(endpoint);
  }
}
