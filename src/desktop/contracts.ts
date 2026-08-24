export const DESKTOP_ORIGIN = 'opencode-infinite://app';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type SseState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'closed';
export type RunStatus =
  | 'initializing'
  | 'connecting'
  | 'working'
  | 'retrying'
  | 'settling'
  | 'continuing'
  | 'stopping'
  | 'completed'
  | 'blocked'
  | 'stopped'
  | 'failed';

export interface StartRunInput {
  task: string;
  workspace: string;
  name: string | null;
  sessionRef: string | null;
  model: string | null;
  agent: string | null;
  binary: string | null;
  attach: string | null;
  maxIterations: number;
  maxHours: number;
  stallMinutes: number;
  sentinel: string;
  todoDetection: boolean;
  autoApprove: boolean;
  autoApproveConfirmation: boolean;
  resumeExisting: boolean;
}

export interface SessionConnectionInput {
  workspace: string;
  binary: string | null;
  attach: string | null;
}

export type OpenCodeSessionStatus = 'idle' | 'busy' | 'retry';

export interface OpenCodeSessionSummary {
  id: string;
  title: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  status: OpenCodeSessionStatus;
  retryMessage: string | null;
  continuous: boolean;
  runId: string | null;
}

export type SetContinuousInput =
  | { enabled: false; sessionId: string; run: null }
  | { enabled: true; sessionId: string; run: StartRunInput };

export interface DoctorInput {
  workspace: string | null;
  binary: string | null;
  attach: string | null;
}

export interface DoctorResult {
  ok: boolean;
  engineAvailable: boolean;
  workspaceReady: boolean;
  binaryReady: boolean | null;
  attachReady: boolean | null;
  mode: 'desktop-sidecar' | 'dedicated' | 'attach' | 'unavailable';
  serverVersion: string | null;
  endpoint: string | null;
  warnings: string[];
}

export interface RunState {
  schemaVersion: 1;
  runId: string;
  operationId: string;
  task: string;
  workspace: string;
  name: string;
  sessionRef: string | null;
  sessionId: string | null;
  model: string | null;
  agent: string | null;
  binary: string | null;
  attach: string | null;
  status: RunStatus;
  reason: string | null;
  iteration: number;
  maxIterations: number;
  maxHours: number;
  stallMinutes: number;
  sentinel: string;
  todoDetection: boolean;
  autoApprove: boolean;
  sseState: SseState;
  tokensInput: number;
  tokensOutput: number;
  cost: number;
  lastMessage: string | null;
  lastEvent: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  lastError: string | null;
}

export interface OperationReceipt {
  operationId: string;
  runId: string;
}

export interface SystemInfo {
  platform: string;
  arch: string;
  version: string;
}

export type DesktopEvent =
  | { type: 'run-changed'; operationId: string; run: RunState }
  | { type: 'operation-finished'; operationId: string; run: RunState }
  | { type: 'operation-error'; operationId: string; runId: string | null; error: { code: string; message: string } }
  | { type: 'sessions-snapshot'; sessions: OpenCodeSessionSummary[] }
  | { type: 'log'; operationId: string | null; runId: string | null; level: LogLevel; message: string; timestamp: string };

export interface DesktopApi {
  systemInfo(): Promise<SystemInfo>;
  doctor(workspace: string | null, binary: string | null, attach: string | null): Promise<DoctorResult>;
  chooseWorkspace(): Promise<string | null>;
  chooseBinary(): Promise<string | null>;
  listRuns(): Promise<RunState[]>;
  getRun(runId: string): Promise<RunState>;
  listSessions(input: SessionConnectionInput): Promise<OpenCodeSessionSummary[]>;
  setContinuous(input: SetContinuousInput): Promise<OperationReceipt>;
  startRun(input: StartRunInput): Promise<OperationReceipt>;
  stopRun(runId: string): Promise<OperationReceipt>;
  onEvent(listener: (event: DesktopEvent) => void): () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function nullableBoundedString(value: unknown, maximum: number): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= maximum);
}

function boundedNumber(value: unknown, minimum: number, maximum: number, integer = false): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum
    && (!integer || Number.isSafeInteger(value));
}

function normalizedOptional(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function assertRunId(value: unknown): asserts value is string {
  if (typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new TypeError('Run ID inválido.');
  }
}

function validateLoopbackAttach(value: string | null): string | null {
  const normalized = normalizedOptional(value);
  if (normalized === null) return null;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new TypeError('La URL del servidor OpenCode no es válida.');
  }
  const host = url.hostname.toLowerCase();
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
    || (host !== 'localhost' && host !== '127.0.0.1' && host !== '[::1]' && host !== '::1')
    || url.username.length > 0 || url.password.length > 0 || url.search.length > 0 || url.hash.length > 0) {
    throw new TypeError('Por seguridad, el servidor adjunto debe ser HTTP(S) loopback y no incluir credenciales.');
  }
  url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
  return url.toString().replace(/\/$/u, '');
}

export function parseDoctorInput(value: unknown): DoctorInput {
  const keys = ['attach', 'binary', 'workspace'];
  if (!isRecord(value) || !hasExactKeys(value, keys)
    || !nullableBoundedString(value.workspace, 32_767)
    || !nullableBoundedString(value.binary, 32_767)
    || !nullableBoundedString(value.attach, 2_048)) {
    throw new TypeError('Parámetros de diagnóstico inválidos.');
  }
  return {
    workspace: normalizedOptional(value.workspace),
    binary: normalizedOptional(value.binary),
    attach: validateLoopbackAttach(value.attach),
  };
}

export function parseStartRunInput(value: unknown): StartRunInput {
  const keys = [
    'agent', 'attach', 'autoApprove', 'autoApproveConfirmation', 'binary', 'maxHours', 'maxIterations',
    'model', 'name', 'resumeExisting', 'sentinel', 'sessionRef', 'stallMinutes', 'task', 'todoDetection', 'workspace',
  ];
  if (!isRecord(value) || !hasExactKeys(value, keys)
    || typeof value.task !== 'string' || value.task.trim().length === 0 || value.task.length > 8_000
    || typeof value.workspace !== 'string' || value.workspace.trim().length === 0 || value.workspace.length > 32_767
    || !nullableBoundedString(value.name, 128)
    || !nullableBoundedString(value.sessionRef, 2_048)
    || !nullableBoundedString(value.model, 512)
    || !nullableBoundedString(value.agent, 256)
    || !nullableBoundedString(value.binary, 32_767)
    || !nullableBoundedString(value.attach, 2_048)
    || !boundedNumber(value.maxIterations, 1, 10_000, true)
    || !boundedNumber(value.maxHours, 0.05, 720)
    || !boundedNumber(value.stallMinutes, 1, 1_440)
    || typeof value.sentinel !== 'string' || value.sentinel.trim().length === 0 || value.sentinel.length > 256
    || typeof value.todoDetection !== 'boolean'
    || typeof value.autoApprove !== 'boolean'
    || typeof value.autoApproveConfirmation !== 'boolean'
    || typeof value.resumeExisting !== 'boolean') {
    throw new TypeError('Parámetros de ejecución inválidos.');
  }
  if (value.autoApprove && !value.autoApproveConfirmation) {
    throw new TypeError('Confirma explícitamente la autoaprobación antes de iniciar.');
  }
  const sessionRef = normalizedOptional(value.sessionRef);
  if (sessionRef !== null && !/^ses_[A-Za-z0-9]+$/u.test(sessionRef)
    && !/^oc:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/u.test(sessionRef)) {
    throw new TypeError('La sesión debe ser un ID ses_… o un deeplink oc:// válido.');
  }
  if (value.resumeExisting && (sessionRef === null || !/^ses_[A-Za-z0-9]+$/u.test(sessionRef))) {
    throw new TypeError('El modo continuo requiere un ID de sesión ses_… exacto.');
  }
  return {
    task: value.task.trim(),
    workspace: value.workspace.trim(),
    name: normalizedOptional(value.name),
    sessionRef,
    model: normalizedOptional(value.model),
    agent: normalizedOptional(value.agent),
    binary: normalizedOptional(value.binary),
    attach: validateLoopbackAttach(value.attach),
    maxIterations: value.maxIterations,
    maxHours: value.maxHours,
    stallMinutes: value.stallMinutes,
    sentinel: value.sentinel.trim(),
    todoDetection: value.todoDetection,
    autoApprove: value.autoApprove,
    autoApproveConfirmation: value.autoApproveConfirmation,
    resumeExisting: value.resumeExisting,
  };
}

export function parseSessionConnectionInput(value: unknown): SessionConnectionInput {
  const keys = ['attach', 'binary', 'workspace'];
  if (!isRecord(value) || !hasExactKeys(value, keys)
    || typeof value.workspace !== 'string' || value.workspace.trim().length === 0 || value.workspace.length > 32_767
    || !nullableBoundedString(value.binary, 32_767)
    || !nullableBoundedString(value.attach, 2_048)) {
    throw new TypeError('Parámetros de sesiones inválidos.');
  }
  return {
    workspace: value.workspace.trim(),
    binary: normalizedOptional(value.binary),
    attach: validateLoopbackAttach(value.attach),
  };
}

export function parseSessionId(value: unknown): string {
  if (typeof value !== 'string' || !/^ses_[A-Za-z0-9]+$/u.test(value)) {
    throw new TypeError('Session ID inválido.');
  }
  return value;
}

export function parseSetContinuousInput(value: unknown): SetContinuousInput {
  const keys = ['enabled', 'run', 'sessionId'];
  if (!isRecord(value) || !hasExactKeys(value, keys) || typeof value.enabled !== 'boolean') {
    throw new TypeError('Parámetros de modo continuo inválidos.');
  }
  const sessionId = parseSessionId(value.sessionId);
  if (!value.enabled) {
    if (value.run !== null) throw new TypeError('Desactivar el modo continuo no admite parámetros de ejecución.');
    return { enabled: false, sessionId, run: null };
  }
  const run = parseStartRunInput(value.run);
  if (!run.resumeExisting || run.sessionRef !== sessionId) {
    throw new TypeError('La ejecución continua debe reanudar exactamente la sesión seleccionada.');
  }
  return { enabled: true, sessionId, run };
}

export function parseRunId(value: unknown): string {
  assertRunId(value);
  return value;
}

export function isDesktopEvent(value: unknown): value is DesktopEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  return value.type === 'run-changed' || value.type === 'operation-finished'
    || value.type === 'operation-error' || value.type === 'sessions-snapshot' || value.type === 'log';
}
