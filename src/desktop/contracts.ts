export const DESKTOP_ORIGIN = 'opencode-infinite://app';

const SESSION_ID_REFERENCE = /^ses_[A-Za-z0-9]+$/u;
const INTERNAL_SESSION_LINK = /^oc:\/\/renderer\/server\/c2lkZWNhcg\/session\/ses_[A-Za-z0-9]+$/u;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type ConnectionMode = 'desktop-sidecar' | 'dedicated' | 'attach';
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

export interface RunAttachment {
  path: string;
  name: string;
  mime: string;
  size: number;
}

export interface StartRunInput {
  task: string;
  attachments: RunAttachment[];
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
  sessionRef: string | null;
}

export interface OpenProjectInput {
  workspace: string;
}

export interface CopySessionLinkInput {
  sessionId: string;
}

export interface ResumeRunInput {
  runId: string;
  confirmed: true;
}

export interface SessionContextInput extends SessionConnectionInput {
  connectionMode: ConnectionMode;
  sessionId: string;
  limit: number;
}

export interface SessionContextMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface SessionContext {
  sessionId: string;
  messages: SessionContextMessage[];
}

export type DeepLinkTarget =
  | { kind: 'run'; id: string }
  | { kind: 'session'; id: string };

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

export interface OpenCodeModelSummary {
  id: string;
  providerId: string;
  providerName: string;
  modelId: string;
  name: string;
  providerDefault: boolean;
}

export interface OpenCodeModelCatalog {
  models: OpenCodeModelSummary[];
  configuredModel: string | null;
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
  schemaVersion: 3;
  runId: string;
  sourceRunId: string | null;
  firstPromptMarker: string | null;
  firstPromptKind: 'objective' | 'continuation' | null;
  operationId: string;
  task: string;
  attachments: RunAttachment[];
  workspace: string;
  name: string;
  sessionRef: string | null;
  sessionId: string | null;
  model: string | null;
  agent: string | null;
  binary: string | null;
  attach: string | null;
  connectionMode: ConnectionMode;
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
  | { type: 'deep-link'; target: DeepLinkTarget }
  | { type: 'log'; operationId: string | null; runId: string | null; level: LogLevel; message: string; timestamp: string };

export interface DesktopApi {
  systemInfo(): Promise<SystemInfo>;
  doctor(workspace: string | null, binary: string | null, attach: string | null): Promise<DoctorResult>;
  chooseWorkspace(): Promise<string | null>;
  chooseBinary(): Promise<string | null>;
  chooseAttachments(): Promise<RunAttachment[]>;
  resolveDroppedAttachments(files: File[]): Promise<RunAttachment[]>;
  listRuns(): Promise<RunState[]>;
  getRun(runId: string): Promise<RunState>;
  listSessions(input: SessionConnectionInput): Promise<OpenCodeSessionSummary[]>;
  listModels(input: SessionConnectionInput): Promise<OpenCodeModelCatalog>;
  openOpenCodeProject(workspace: string): Promise<void>;
  copyOpenCodeSessionLink(sessionId: string): Promise<void>;
  copyRunDeepLink(runId: string): Promise<void>;
  copySessionDeepLink(sessionId: string): Promise<void>;
  getSessionContext(input: SessionContextInput): Promise<SessionContext>;
  setContinuous(input: SetContinuousInput): Promise<OperationReceipt>;
  startRun(input: StartRunInput): Promise<OperationReceipt>;
  resumeRun(input: ResumeRunInput): Promise<OperationReceipt>;
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

function parseAttachments(value: unknown): RunAttachment[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new TypeError('Adjuntos inválidos.');
  }
  return value.map((attachment) => {
    const keys = ['mime', 'name', 'path', 'size'];
    if (!isRecord(attachment) || !hasExactKeys(attachment, keys)
      || typeof attachment.path !== 'string' || attachment.path.length === 0 || attachment.path.length > 32_767
      || typeof attachment.name !== 'string' || attachment.name.length === 0 || attachment.name.length > 1_024
      || typeof attachment.mime !== 'string' || attachment.mime.length === 0 || attachment.mime.length > 256
      || !boundedNumber(attachment.size, 0, 20 * 1024 * 1024, true)) {
      throw new TypeError('Adjuntos inválidos.');
    }
    return {
      path: attachment.path,
      name: attachment.name,
      mime: attachment.mime,
      size: attachment.size,
    };
  });
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
    'agent', 'attach', 'attachments', 'autoApprove', 'autoApproveConfirmation', 'binary', 'maxHours', 'maxIterations',
    'model', 'name', 'resumeExisting', 'sentinel', 'sessionRef', 'stallMinutes', 'task', 'todoDetection', 'workspace',
  ];
  if (!isRecord(value) || !hasExactKeys(value, keys)
    || typeof value.task !== 'string' || value.task.trim().length === 0
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
  if (sessionRef !== null && !SESSION_ID_REFERENCE.test(sessionRef) && !INTERNAL_SESSION_LINK.test(sessionRef)) {
    throw new TypeError('La sesión debe ser un ID ses_… o un enlace interno de OpenCode Desktop válido.');
  }
  if (value.resumeExisting && (sessionRef === null || !SESSION_ID_REFERENCE.test(sessionRef))) {
    throw new TypeError('El modo continuo requiere un ID de sesión ses_… exacto.');
  }
  return {
    task: value.task.trim(),
    attachments: parseAttachments(value.attachments),
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
  const keys = ['attach', 'binary', 'sessionRef', 'workspace'];
  if (!isRecord(value) || !hasExactKeys(value, keys)
    || typeof value.workspace !== 'string' || value.workspace.trim().length === 0 || value.workspace.length > 32_767
    || !nullableBoundedString(value.binary, 32_767)
    || !nullableBoundedString(value.attach, 2_048)
    || !nullableBoundedString(value.sessionRef, 2_048)) {
    throw new TypeError('Parámetros de sesiones inválidos.');
  }
  const sessionRef = normalizedOptional(value.sessionRef);
  if (sessionRef !== null && !SESSION_ID_REFERENCE.test(sessionRef) && !INTERNAL_SESSION_LINK.test(sessionRef)) {
    throw new TypeError('La sesión debe ser un ID ses_… o un enlace interno de OpenCode Desktop válido.');
  }
  return {
    workspace: value.workspace.trim(),
    binary: normalizedOptional(value.binary),
    attach: validateLoopbackAttach(value.attach),
    sessionRef,
  };
}

export function parseSessionId(value: unknown): string {
  if (typeof value !== 'string' || !/^ses_[A-Za-z0-9]+$/u.test(value)) {
    throw new TypeError('Session ID inválido.');
  }
  return value;
}

export function parseOpenProjectInput(value: unknown): OpenProjectInput {
  if (!isRecord(value) || !hasExactKeys(value, ['workspace'])
    || typeof value.workspace !== 'string' || value.workspace.length === 0 || value.workspace.length > 32_767) {
    throw new TypeError('Parámetros para abrir el proyecto inválidos.');
  }
  return { workspace: value.workspace };
}

export function parseCopySessionLinkInput(value: unknown): CopySessionLinkInput {
  if (!isRecord(value) || !hasExactKeys(value, ['sessionId'])) {
    throw new TypeError('Parámetros para copiar el enlace inválidos.');
  }
  return { sessionId: parseSessionId(value.sessionId) };
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
  if (run.autoApprove) {
    throw new TypeError('Los permisos de sesiones existentes se confirman directamente en OpenCode Desktop.');
  }
  return { enabled: true, sessionId, run };
}

export function parseRunId(value: unknown): string {
  assertRunId(value);
  return value;
}

export function parseResumeRunInput(value: unknown): ResumeRunInput {
  if (!isRecord(value) || !hasExactKeys(value, ['confirmed', 'runId']) || value.confirmed !== true) {
    throw new TypeError('La reanudación requiere confirmación explícita.');
  }
  return { runId: parseRunId(value.runId), confirmed: true };
}

export function parseSessionContextInput(value: unknown): SessionContextInput {
  if (!isRecord(value) || !hasExactKeys(value, ['attach', 'binary', 'connectionMode', 'limit', 'sessionId', 'sessionRef', 'workspace'])
    || !boundedNumber(value.limit, 1, 20, true)
    || (value.connectionMode !== 'desktop-sidecar' && value.connectionMode !== 'dedicated' && value.connectionMode !== 'attach')) {
    throw new TypeError('Parámetros de contexto inválidos.');
  }
  const connection = parseSessionConnectionInput({
    workspace: value.workspace,
    binary: value.binary,
    attach: value.attach,
    sessionRef: value.sessionRef,
  });
  const sessionId = parseSessionId(value.sessionId);
  const referencedSessionId = connection.sessionRef === null
    ? null
    : SESSION_ID_REFERENCE.test(connection.sessionRef)
      ? connection.sessionRef
      : connection.sessionRef.slice(connection.sessionRef.lastIndexOf('/') + 1);
  if ((value.connectionMode === 'attach') !== (connection.attach !== null)
    || (referencedSessionId !== null && referencedSessionId !== sessionId)) {
    throw new TypeError('Parámetros de contexto inválidos.');
  }
  return { ...connection, sessionId, connectionMode: value.connectionMode, limit: value.limit };
}

export function parseDeepLink(value: unknown): DeepLinkTarget | null {
  if (typeof value !== 'string' || value.length > 2_048) return null;
  const run = /^opencode-infinite:\/\/run\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u.exec(value);
  if (run?.[1]) return { kind: 'run', id: run[1] };
  const session = /^opencode-infinite:\/\/session\/(ses_[A-Za-z0-9]+)$/u.exec(value);
  if (session?.[1]) return { kind: 'session', id: session[1] };
  return null;
}

export function buildRunDeepLink(runId: string): string {
  return `opencode-infinite://run/${parseRunId(runId).toLowerCase()}`;
}

export function buildSessionDeepLink(sessionId: string): string {
  return `opencode-infinite://session/${parseSessionId(sessionId)}`;
}

export function isDesktopEvent(value: unknown): value is DesktopEvent {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'deep-link') {
    if (!isRecord(value.target) || !hasExactKeys(value.target, ['id', 'kind']) || typeof value.target.id !== 'string') return false;
    if (value.target.kind === 'run') return parseDeepLink(`opencode-infinite://run/${value.target.id}`) !== null;
    if (value.target.kind === 'session') return parseDeepLink(`opencode-infinite://session/${value.target.id}`) !== null;
    return false;
  }
  return value.type === 'run-changed' || value.type === 'operation-finished'
    || value.type === 'operation-error' || value.type === 'sessions-snapshot' || value.type === 'log';
}
