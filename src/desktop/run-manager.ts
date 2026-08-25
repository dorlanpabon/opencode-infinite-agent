import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type {
  DesktopEvent,
  DoctorInput,
  DoctorResult,
  LogLevel,
  OpenCodeSessionSummary,
  OperationReceipt,
  RunAttachment,
  RunState,
  RunStatus,
  SseState,
  SessionConnectionInput,
  SetContinuousInput,
  StartRunInput,
} from './contracts.js';

const { safeText } = require('../safe-text.js') as {
  safeText(value: unknown, maximum?: number): string;
};

export { safeText };

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ACTIVE_STATUSES = new Set<RunStatus>([
  'initializing', 'connecting', 'working', 'retrying', 'settling', 'continuing', 'stopping',
]);
const RUN_STATUSES = new Set<RunStatus>([
  ...ACTIVE_STATUSES, 'completed', 'blocked', 'stopped', 'failed',
]);
const SSE_STATES = new Set<SseState>(['disconnected', 'connecting', 'connected', 'reconnecting', 'closed']);

export class DesktopRunError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DesktopRunError';
  }
}

export type EngineEvent =
  | { type: 'phase'; status: Extract<RunStatus, 'connecting' | 'working' | 'retrying' | 'settling' | 'continuing'>; detail?: string }
  | { type: 'transport'; state: SseState; detail?: string }
  | { type: 'session'; sessionId: string }
  | {
    type: 'progress';
    iteration: number;
    tokensInput?: number;
    tokensOutput?: number;
    cost?: number;
    lastMessage?: string;
    detail?: string;
  }
  | { type: 'log'; level: LogLevel; message: string };

export interface EngineRunContext {
  runId: string;
  operationId: string;
  signal: AbortSignal;
  emit(event: EngineEvent): Promise<void>;
}

export interface EngineRunResult {
  status: 'completed' | 'blocked' | 'stopped';
  reason: string;
  sessionId?: string;
  iteration?: number;
  tokensInput?: number;
  tokensOutput?: number;
  cost?: number;
  lastMessage?: string;
}

/**
 * Integration boundary for the existing OpenCode engine.
 *
 * Implementations must drive continuation from OpenCode SSE lifecycle events.
 * A timer may be used as a watchdog, but must never enqueue continuation prompts.
 * Every permission and lifecycle event must be scoped to the exact managed session.
 */
export interface DesktopEngineAdapter {
  doctor(input: DoctorInput): Promise<DoctorResult>;
  run(input: StartRunInput, context: EngineRunContext): Promise<EngineRunResult>;
  listSessions?(
    input: SessionConnectionInput,
    listener: (sessions: OpenCodeSessionSummary[]) => void,
  ): Promise<OpenCodeSessionSummary[]>;
  stop?(runId: string, sessionId: string | null): Promise<void>;
  shutdown?(): Promise<void>;
}

interface ActiveRun {
  controller: AbortController;
  operationId: string;
  promise: Promise<void>;
  runId: string;
  workspaceKey: string;
}

export type DesktopEventSink = (event: DesktopEvent) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function nullableString(value: unknown, maximum: number): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= maximum);
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isRunAttachment(value: unknown): value is RunAttachment {
  return isRecord(value)
    && typeof value.path === 'string' && path.isAbsolute(value.path) && value.path.length <= 32_767
    && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 1_024
    && typeof value.mime === 'string' && value.mime.length > 0 && value.mime.length <= 256
    && Number.isSafeInteger(value.size) && (value.size as number) >= 0 && (value.size as number) <= 20 * 1024 * 1024;
}

function isRunState(value: unknown): value is RunState {
  if (!isRecord(value)) return false;
  return value.schemaVersion === 1
    && typeof value.runId === 'string' && RUN_ID.test(value.runId)
    && typeof value.operationId === 'string' && RUN_ID.test(value.operationId)
    && typeof value.task === 'string' && value.task.length > 0
    && Array.isArray(value.attachments) && value.attachments.length <= 100 && value.attachments.every(isRunAttachment)
    && typeof value.workspace === 'string' && path.isAbsolute(value.workspace) && value.workspace.length <= 32_767
    && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 128
    && nullableString(value.sessionRef, 2_048) && nullableString(value.sessionId, 256)
    && nullableString(value.model, 512) && nullableString(value.agent, 256)
    && nullableString(value.binary, 32_767) && nullableString(value.attach, 2_048)
    && typeof value.status === 'string' && RUN_STATUSES.has(value.status as RunStatus)
    && nullableString(value.reason, 4_000)
    && Number.isSafeInteger(value.iteration) && (value.iteration as number) >= 0
    && Number.isSafeInteger(value.maxIterations) && (value.maxIterations as number) >= 1
    && finiteNonNegative(value.maxHours) && finiteNonNegative(value.stallMinutes)
    && typeof value.sentinel === 'string' && value.sentinel.length > 0 && value.sentinel.length <= 256
    && typeof value.todoDetection === 'boolean' && typeof value.autoApprove === 'boolean'
    && typeof value.sseState === 'string' && SSE_STATES.has(value.sseState as SseState)
    && finiteNonNegative(value.tokensInput) && finiteNonNegative(value.tokensOutput) && finiteNonNegative(value.cost)
    && nullableString(value.lastMessage, 16_000) && nullableString(value.lastEvent, 2_000)
    && validDate(value.createdAt) && validDate(value.updatedAt)
    && (value.completedAt === null || validDate(value.completedAt))
    && nullableString(value.lastError, 4_000);
}

function operationError(error: unknown): { code: string; message: string } {
  if (error instanceof DesktopRunError) return { code: error.code, message: safeText(error.message) };
  return { code: 'UNEXPECTED_ERROR', message: safeText(error) };
}

function workspaceKey(workspace: string): string {
  const resolved = path.resolve(workspace);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sessionConnectionKey(input: SessionConnectionInput): string {
  return JSON.stringify([workspaceKey(input.workspace), input.binary, input.attach]);
}

function titleFromTask(task: string): string {
  const firstLine = task.split(/\r?\n/u, 1)[0]?.trim() || 'Ejecución OpenCode';
  return firstLine.length <= 72 ? firstLine : `${firstLine.slice(0, 69)}…`;
}

function applyResult(state: RunState, result: EngineRunResult): void {
  state.status = result.status;
  state.reason = safeText(result.reason);
  if (result.sessionId !== undefined) state.sessionId = safeText(result.sessionId, 256);
  if (result.iteration !== undefined && Number.isSafeInteger(result.iteration) && result.iteration >= 0) {
    state.iteration = Math.min(result.iteration, state.maxIterations);
  }
  if (finiteNonNegative(result.tokensInput)) state.tokensInput = result.tokensInput;
  if (finiteNonNegative(result.tokensOutput)) state.tokensOutput = result.tokensOutput;
  if (finiteNonNegative(result.cost)) state.cost = result.cost;
  if (result.lastMessage !== undefined) state.lastMessage = safeText(result.lastMessage, 16_000);
  state.sseState = 'closed';
  state.completedAt = new Date().toISOString();
}

export class RunManager {
  private readonly active = new Map<string, ActiveRun>();
  private readonly states = new Map<string, RunState>();
  private readonly writeChains = new Map<string, Promise<void>>();
  private readonly sessionLeases = new Set<string>();
  private readonly runsDirectory: string;
  private catalogSessions: OpenCodeSessionSummary[] = [];
  private catalogLoaded = false;
  private adapter: DesktopEngineAdapter | null;

  constructor(
    private readonly emit: DesktopEventSink,
    userDataDirectory: string,
    adapter: DesktopEngineAdapter | null = null,
  ) {
    if (!path.isAbsolute(userDataDirectory)) throw new TypeError('El directorio de datos Desktop debe ser absoluto.');
    this.runsDirectory = path.join(userDataDirectory, 'runs');
    this.adapter = adapter;
  }

  get hasActiveRuns(): boolean {
    return this.active.size > 0;
  }

  get hasAdapter(): boolean {
    return this.adapter !== null;
  }

  setAdapter(adapter: DesktopEngineAdapter): void {
    if (this.active.size > 0) throw new DesktopRunError('ENGINE_BUSY', 'No se puede reemplazar el motor con ejecuciones activas.');
    this.adapter = adapter;
  }

  async initialize(): Promise<void> {
    await mkdir(this.runsDirectory, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.runsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !RUN_ID.test(entry.name.replace(/\.json$/iu, '')) || !entry.name.endsWith('.json')) continue;
      const state = await this.readStateFile(path.join(this.runsDirectory, entry.name));
      if (!state) continue;
      if (ACTIVE_STATUSES.has(state.status)) {
        state.status = 'stopped';
        state.reason = 'La aplicación anterior terminó sin confirmar el cierre de esta ejecución.';
        state.lastError = state.reason;
        state.sseState = 'closed';
        state.completedAt = new Date().toISOString();
        await this.persist(state);
      }
      this.states.set(state.runId, state);
    }
  }

  async doctor(input: DoctorInput): Promise<DoctorResult> {
    if (!this.adapter) {
      return {
        ok: false,
        engineAvailable: false,
        workspaceReady: false,
        binaryReady: input.binary === null ? null : false,
        attachReady: input.attach === null ? null : false,
        mode: 'unavailable',
        serverVersion: null,
        endpoint: input.attach,
        warnings: ['El adaptador real del motor OpenCode aún no está integrado en esta compilación.'],
      };
    }
    return this.adapter.doctor(input);
  }

  async listRuns(): Promise<RunState[]> {
    return [...this.states.values()]
      .map((state) => structuredClone(state))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getRun(runId: string): Promise<RunState> {
    const state = this.states.get(runId);
    if (!state) throw new DesktopRunError('RUN_NOT_FOUND', 'La ejecución solicitada no existe.');
    return structuredClone(state);
  }

  async listSessions(input: SessionConnectionInput): Promise<OpenCodeSessionSummary[]> {
    if (!this.adapter?.listSessions) {
      throw new DesktopRunError('SESSIONS_UNAVAILABLE', 'El motor OpenCode no expone un catálogo de sesiones.');
    }
    const activeState = [...this.active.keys()].map((runId) => this.states.get(runId)).find(Boolean);
    if (activeState) {
      if (sessionConnectionKey(input) !== sessionConnectionKey(activeState)) {
        throw new DesktopRunError(
          'ENGINE_BUSY',
          'No se puede cambiar el servidor de sesiones mientras existe una ejecución activa.',
        );
      }
      return this.decorateSessions();
    }
    const sessions = await this.adapter.listSessions(input, (next) => this.updateCatalog(next));
    this.updateCatalog(sessions);
    return this.decorateSessions();
  }

  async setContinuous(input: SetContinuousInput): Promise<OperationReceipt> {
    if (input.enabled) return this.start(input.run);
    return this.pauseSession(input.sessionId);
  }

  async start(input: StartRunInput): Promise<OperationReceipt> {
    const adapter = this.adapter;
    if (!adapter) throw new DesktopRunError('ENGINE_UNAVAILABLE', 'El motor OpenCode Desktop no está integrado en esta compilación.');

    const key = workspaceKey(input.workspace);
    const sessionLease = input.resumeExisting && input.sessionRef ? input.sessionRef : null;
    if (sessionLease && this.sessionLeases.has(sessionLease)) {
      throw new DesktopRunError('SESSION_ALREADY_MANAGED', 'La sesión ya tiene el modo continuo activo.');
    }
    if (this.active.size > 0) {
      throw new DesktopRunError('ENGINE_BUSY', 'OpenCode Infinite ya tiene una ejecución activa.');
    }
    if (sessionLease) this.sessionLeases.add(sessionLease);

    const operationId = randomUUID();
    const runId = randomUUID();
    const now = new Date().toISOString();
    const state: RunState = {
      schemaVersion: 1,
      runId,
      operationId,
      task: input.task,
      attachments: structuredClone(input.attachments),
      workspace: path.resolve(input.workspace),
      name: input.name ?? titleFromTask(input.task),
      sessionRef: input.sessionRef,
      sessionId: null,
      model: input.model,
      agent: input.agent,
      binary: input.binary,
      attach: input.attach,
      status: 'initializing',
      reason: null,
      iteration: 0,
      maxIterations: input.maxIterations,
      maxHours: input.maxHours,
      stallMinutes: input.stallMinutes,
      sentinel: input.sentinel,
      todoDetection: input.todoDetection,
      autoApprove: input.autoApprove,
      sseState: 'disconnected',
      tokensInput: 0,
      tokensOutput: 0,
      cost: 0,
      lastMessage: null,
      lastEvent: 'Ejecución creada.',
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      lastError: null,
    };
    const controller = new AbortController();
    const active: ActiveRun = {
      controller,
      operationId,
      promise: Promise.resolve(),
      runId,
      workspaceKey: key,
    };
    this.states.set(runId, state);
    this.active.set(runId, active);
    try {
      await this.persist(state);
    } catch (error) {
      this.active.delete(runId);
      this.states.delete(runId);
      if (sessionLease) this.sessionLeases.delete(sessionLease);
      throw error;
    }
    this.publishState(state);
    active.promise = this.execute(adapter, input, state, controller.signal)
      .finally(() => {
        this.active.delete(runId);
        if (sessionLease) this.sessionLeases.delete(sessionLease);
        this.publishSessions();
      });
    return { operationId, runId };
  }

  async stop(runId: string): Promise<OperationReceipt> {
    const active = this.active.get(runId);
    if (!active) throw new DesktopRunError('RUN_NOT_ACTIVE', 'La ejecución no está activa en esta instancia.');
    const state = this.states.get(runId);
    if (!state) throw new DesktopRunError('RUN_NOT_FOUND', 'La ejecución activa no tiene estado durable.');
    if (state.status !== 'stopping') {
      state.status = 'stopping';
      state.reason = 'Detención solicitada por el usuario.';
      state.lastEvent = state.reason;
      await this.persistAndPublish(state);
    }
    active.controller.abort(new DesktopRunError('RUN_STOPPED', 'Detención solicitada por el usuario.'));
    if (this.adapter?.stop) {
      void this.adapter.stop(runId, state.sessionId).catch((error: unknown) => {
        this.publishLog('warn', `El motor no confirmó la detención: ${safeText(error)}`, state);
      });
    }
    return { operationId: active.operationId, runId };
  }

  async pauseSession(sessionId: string): Promise<OperationReceipt> {
    if (!this.sessionLeases.has(sessionId)) {
      throw new DesktopRunError('SESSION_NOT_MANAGED', 'La sesión no tiene el modo continuo activo.');
    }
    const state = [...this.active.keys()]
      .map((runId) => this.states.get(runId))
      .find((candidate) => candidate?.sessionRef === sessionId && ACTIVE_STATUSES.has(candidate.status));
    if (!state) throw new DesktopRunError('SESSION_NOT_MANAGED', 'La sesión no tiene el modo continuo activo.');
    const active = this.active.get(state.runId);
    if (!active) throw new DesktopRunError('RUN_NOT_ACTIVE', 'La supervisión no está activa en esta instancia.');
    const reason = 'Modo continuo desactivado; el turno actual continúa en OpenCode.';
    active.controller.abort(new DesktopRunError('RUN_PAUSED', reason));
    await active.promise;
    return { operationId: active.operationId, runId: active.runId };
  }

  async shutdown(): Promise<void> {
    const active = [...this.active.values()];
    for (const run of active) {
      const state = this.states.get(run.runId);
      run.controller.abort(new DesktopRunError('APP_SHUTDOWN', 'La aplicación se está cerrando.'));
      if (this.adapter?.stop) void this.adapter.stop(run.runId, state?.sessionId ?? null).catch(() => undefined);
    }
    await Promise.allSettled(active.map((run) => run.promise));
    if (this.adapter?.shutdown) await this.adapter.shutdown();
  }

  private async execute(
    adapter: DesktopEngineAdapter,
    input: StartRunInput,
    state: RunState,
    signal: AbortSignal,
  ): Promise<void> {
    let eventChain = Promise.resolve();
    const queueEvent = (event: EngineEvent): Promise<void> => {
      eventChain = eventChain.then(() => this.applyEngineEvent(state, event));
      return eventChain;
    };

    try {
      state.status = 'connecting';
      state.lastEvent = 'Conectando con OpenCode…';
      await this.persistAndPublish(state);
      const result = await adapter.run(input, {
        runId: state.runId,
        operationId: state.operationId,
        signal,
        emit: queueEvent,
      });
      await eventChain;
      applyResult(state, signal.aborted
        ? { status: 'stopped', reason: safeText(signal.reason ?? 'Ejecución detenida.') }
        : result);
      await this.persistAndPublish(state);
      this.emit({ type: 'operation-finished', operationId: state.operationId, run: structuredClone(state) });
    } catch (error) {
      await eventChain.catch(() => undefined);
      const stopped = signal.aborted;
      const serialized = operationError(error);
      state.status = stopped ? 'stopped' : 'failed';
      state.reason = stopped ? safeText(signal.reason ?? 'Ejecución detenida.') : serialized.message;
      state.lastError = stopped ? null : serialized.message;
      state.sseState = 'closed';
      state.completedAt = new Date().toISOString();
      await this.persistAndPublish(state).catch(() => undefined);
      if (!stopped) {
        this.emit({
          type: 'operation-error',
          operationId: state.operationId,
          runId: state.runId,
          error: serialized,
        });
      }
      this.emit({ type: 'operation-finished', operationId: state.operationId, run: structuredClone(state) });
    }
  }

  private async applyEngineEvent(state: RunState, event: EngineEvent): Promise<void> {
    switch (event.type) {
      case 'phase':
        state.status = event.status;
        state.lastEvent = safeText(event.detail ?? `Estado del motor: ${event.status}.`, 2_000);
        break;
      case 'transport':
        state.sseState = event.state;
        state.lastEvent = safeText(event.detail ?? `SSE: ${event.state}.`, 2_000);
        break;
      case 'session':
        if (!/^ses_[A-Za-z0-9]+$/u.test(event.sessionId)) {
          throw new DesktopRunError('INVALID_ENGINE_EVENT', 'El motor informó un ID de sesión inválido.');
        }
        state.sessionId = event.sessionId;
        state.lastEvent = 'Sesión OpenCode vinculada.';
        break;
      case 'progress':
        if (!Number.isSafeInteger(event.iteration) || event.iteration < 0 || event.iteration > state.maxIterations) {
          throw new DesktopRunError('INVALID_ENGINE_EVENT', 'El motor informó una iteración inválida.');
        }
        state.iteration = event.iteration;
        if (finiteNonNegative(event.tokensInput)) state.tokensInput = event.tokensInput;
        if (finiteNonNegative(event.tokensOutput)) state.tokensOutput = event.tokensOutput;
        if (finiteNonNegative(event.cost)) state.cost = event.cost;
        if (event.lastMessage !== undefined) state.lastMessage = safeText(event.lastMessage, 16_000);
        state.lastEvent = safeText(event.detail ?? `Iteración ${event.iteration} confirmada.`, 2_000);
        break;
      case 'log':
        this.publishLog(event.level, event.message, state);
        return;
    }
    await this.persistAndPublish(state);
  }

  private publishLog(level: LogLevel, message: string, state: RunState | null): void {
    this.emit({
      type: 'log',
      operationId: state?.operationId ?? null,
      runId: state?.runId ?? null,
      level,
      message: safeText(message),
      timestamp: new Date().toISOString(),
    });
  }

  private publishState(state: RunState): void {
    this.emit({ type: 'run-changed', operationId: state.operationId, run: structuredClone(state) });
    this.publishSessions();
  }

  private updateCatalog(sessions: OpenCodeSessionSummary[]): void {
    this.catalogLoaded = true;
    this.catalogSessions = sessions.map((session) => ({ ...session, continuous: false, runId: null }));
    this.publishSessions();
  }

  private decorateSessions(): OpenCodeSessionSummary[] {
    return this.catalogSessions.map((session) => {
      const run = this.sessionLeases.has(session.id)
        ? [...this.active.keys()]
          .map((runId) => this.states.get(runId))
          .find((candidate) => candidate?.sessionRef === session.id && ACTIVE_STATUSES.has(candidate.status))
        : undefined;
      return { ...session, continuous: Boolean(run), runId: run?.runId ?? null };
    });
  }

  private publishSessions(): void {
    if (!this.catalogLoaded) return;
    this.emit({ type: 'sessions-snapshot', sessions: this.decorateSessions() });
  }

  private async persistAndPublish(state: RunState): Promise<void> {
    await this.persist(state);
    this.publishState(state);
  }

  private async persist(state: RunState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    if (!isRunState(state)) throw new DesktopRunError('INVALID_RUN_STATE', 'El estado de la ejecución no pasó validación.');
    const snapshot = structuredClone(state);
    const prior = this.writeChains.get(state.runId) ?? Promise.resolve();
    const queued = prior.then(() => this.writeState(snapshot));
    this.writeChains.set(state.runId, queued);
    try {
      await queued;
      this.states.set(snapshot.runId, snapshot);
      Object.assign(state, snapshot);
    } finally {
      if (this.writeChains.get(state.runId) === queued) this.writeChains.delete(state.runId);
    }
  }

  private async writeState(state: RunState): Promise<void> {
    await mkdir(this.runsDirectory, { recursive: true, mode: 0o700 });
    const target = path.join(this.runsDirectory, `${state.runId}.json`);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private async readStateFile(file: string): Promise<RunState | null> {
    try {
      const info = await stat(file);
      if (!info.isFile()) return null;
      const value: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (isRecord(value) && value.schemaVersion === 1 && value.attachments === undefined) value.attachments = [];
      return isRunState(value) ? value : null;
    } catch {
      return null;
    }
  }
}
