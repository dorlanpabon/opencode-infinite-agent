import type {
  DoctorInput,
  DoctorResult,
  OpenCodeModelCatalog,
  OpenCodeSessionSummary,
  SessionContext,
  SessionContextInput,
  SessionConnectionInput,
} from './contracts.js';
import type { DesktopEngineAdapter, EngineRunContext, EngineRunResult, EngineStartInput } from './run-manager.js';
import { assertAttachmentMetadata } from './attachments.js';
import { OpenCodeDesktopBridgeCatalog } from './desktop-bridge.js';
import { OpenCodeSessionCatalog } from './session-catalog.js';

interface AgentResult {
  status: 'complete' | 'max-iterations' | 'aborted' | 'error';
  reason: string;
  sessionId: string;
  state: {
    iterations: number;
    tokens: { input: number; output: number };
    cost: number;
    lastText: string;
  };
}

export interface AgentModule {
  executeAgent(input: Record<string, unknown>, options: {
    signal: AbortSignal;
    log: Record<string, (message: string) => void>;
    onSession(sessionId: string): void | Promise<void>;
    onTransport(state: 'connecting' | 'connected' | 'closed'): void;
    onState(event: {
      phase: 'working' | 'continuing' | 'settling';
      iteration: number;
      tokens?: { input: number; output: number };
      cost?: number;
      lastText?: string;
    }): void;
    beforeFirstPrompt?(): Promise<void>;
    abortRemoteOnSignal?: boolean;
  }): Promise<AgentResult>;
}

interface ServerModule {
  findBinary(explicit?: string | null): string;
  health(base: string): Promise<string | null>;
}

export interface ServerSessionCatalogAdapter {
  setListener(listener: (sessions: OpenCodeSessionSummary[]) => void): void;
  matches(input: SessionConnectionInput): boolean;
  connect(input: SessionConnectionInput): Promise<{ base: string; sessions: OpenCodeSessionSummary[] }>;
  reconcile(): Promise<OpenCodeSessionSummary[]>;
  models(): Promise<OpenCodeModelCatalog>;
  context(sessionId: string, limit: number): Promise<SessionContext>;
  close(): Promise<void>;
}

export interface DesktopSessionCatalogAdapter {
  setListener(listener: (sessions: OpenCodeSessionSummary[]) => void): void;
  readonly connected: boolean;
  connect(input: SessionConnectionInput): Promise<{ sessions: OpenCodeSessionSummary[] }>;
  endpointForSession(sessionId: string): { endpoint: string; directory: string };
  reconcile(): Promise<OpenCodeSessionSummary[]>;
  models(workspace?: string): Promise<OpenCodeModelCatalog>;
  context(sessionId: string, workspace: string, limit: number): Promise<SessionContext>;
  close(): Promise<void>;
}

export interface OpenCodeEngineAdapterOptions {
  serverCatalog?: ServerSessionCatalogAdapter;
  createServerCatalog?: () => ServerSessionCatalogAdapter;
  desktopCatalog?: DesktopSessionCatalogAdapter;
  agentModule?: AgentModule;
}

const defaultAgentModule = require('../agent.js') as AgentModule;
const serverModule = require('../server.js') as ServerModule;

function emit(context: EngineRunContext, event: Parameters<EngineRunContext['emit']>[0]): void {
  void context.emit(event).catch(() => undefined);
}

function logger(context: EngineRunContext): Record<string, (message: string) => void> {
  return {
    banner: (message) => emit(context, { type: 'log', level: 'info', message }),
    ok: (message) => emit(context, { type: 'log', level: 'info', message }),
    info: (message) => emit(context, { type: 'log', level: 'info', message }),
    warn: (message) => emit(context, { type: 'log', level: 'warn', message }),
    err: (message) => emit(context, { type: 'log', level: 'error', message }),
    error: (message) => emit(context, { type: 'log', level: 'error', message }),
    debug: (message) => emit(context, { type: 'log', level: 'debug', message }),
  };
}

async function doctor(input: DoctorInput): Promise<DoctorResult> {
  const warnings: string[] = [];
  if (input.attach) {
    const version = await serverModule.health(input.attach);
    if (!version) warnings.push('El servidor local adjunto no respondió o requiere OPENCODE_SERVER_PASSWORD.');
    return {
      ok: Boolean(version),
      engineAvailable: Boolean(version),
      workspaceReady: true,
      binaryReady: input.binary === null ? null : true,
      attachReady: Boolean(version),
      mode: 'attach',
      serverVersion: version,
      endpoint: input.attach,
      warnings,
    };
  }

  let binaryReady = false;
  try {
    serverModule.findBinary(input.binary);
    binaryReady = true;
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : String(error));
  }
  return {
    ok: binaryReady,
    engineAvailable: binaryReady,
    workspaceReady: true,
    binaryReady,
    attachReady: null,
    mode: binaryReady ? 'dedicated' : 'unavailable',
    serverVersion: null,
    endpoint: null,
    warnings,
  };
}

async function run(
  input: EngineStartInput,
  context: EngineRunContext,
  catalog: ServerSessionCatalogAdapter,
  desktopCatalog: DesktopSessionCatalogAdapter,
  agentModule: AgentModule,
): Promise<EngineRunResult> {
  const controller = new AbortController();
  let wallLimited = false;
  const relayAbort = () => controller.abort(context.signal.reason);
  if (context.signal.aborted) relayAbort();
  else context.signal.addEventListener('abort', relayAbort, { once: true });
  const wallTimer = setTimeout(() => {
    wallLimited = true;
    controller.abort(new Error('Se alcanzó el límite de tiempo de la ejecución.'));
  }, Math.max(1, Math.floor(input.maxHours * 60 * 60 * 1000)));

  emit(context, { type: 'phase', status: 'connecting', detail: 'Conectando al stream de eventos de OpenCode…' });
  let desktopSessionId: string | null = null;
  try {
    const connectionInput: SessionConnectionInput = {
      workspace: input.workspace,
      binary: input.binary,
      attach: input.attach,
      sessionRef: input.sessionRef,
    };
    const ref = input.sessionRef;
    const isDesktopSession = input.connectionMode === 'desktop-sidecar';
    let connection;
    if (isDesktopSession) {
      await desktopCatalog.connect(connectionInput);
      connection = desktopCatalog.endpointForSession(ref!);
    } else {
      connection = await catalog.connect(connectionInput);
    }
    const executionWorkspace = 'directory' in connection ? connection.directory : input.workspace;
    if (isDesktopSession) desktopSessionId = ref;
    if (desktopSessionId && input.autoApprove) {
      throw new Error('OpenCode Desktop no permite autoaprobar de forma fiable los permisos de una sesión existente. Confírmalos en OpenCode.');
    }
    const sendObjective = input.recoveryMode === 'new-objective'
      || (input.recoveryMode === 'recover-first-prompt' && input.firstPromptKind === 'objective');
    const result = await agentModule.executeAgent({
      dir: executionWorkspace,
      prompt: sendObjective ? input.task : undefined,
      attachments: sendObjective ? input.attachments : [],
      recoveryMode: input.recoveryMode,
      firstPromptMarker: input.firstPromptMarker,
      resumeExisting: input.resumeExisting,
      session: ref && ref.startsWith('ses_') ? ref : undefined,
      deeplink: ref && ref.startsWith('oc://') ? ref : undefined,
      title: input.name,
      model: input.model,
      agent: input.agent,
      binary: input.binary,
      attach: 'endpoint' in connection ? connection.endpoint : connection.base,
      maxIterations: input.maxIterations,
      stallTimeoutMin: input.stallMinutes,
      turnHardTimeoutMin: Math.max(input.stallMinutes, Math.ceil(input.maxHours * 60)),
      sentinel: input.sentinel,
      noTodos: !input.todoDetection,
      autoApprove: input.autoApprove && !isDesktopSession,
      keepServer: false,
      exclusiveServer: false,
    }, {
      signal: controller.signal,
      log: logger(context),
      onSession: (sessionId) => context.emit({ type: 'session', sessionId }),
      onTransport: (state) => {
        emit(context, {
          type: 'transport',
          state,
          detail: state === 'connected' ? 'SSE conectado; la continuación depende de eventos terminales.' : `SSE: ${state}.`,
        });
        if (state === 'connected') emit(context, { type: 'phase', status: 'working', detail: 'OpenCode está trabajando.' });
      },
      onState: (event) => {
        emit(context, {
          type: 'phase',
          status: event.phase,
          detail: event.phase === 'settling'
            ? 'Turno finalizado; verificando estado persistido y señales de tarea.'
            : event.phase === 'continuing'
              ? 'Turno incompleto confirmado; enviando la siguiente continuación.'
              : 'OpenCode está trabajando.',
        });
        if (event.phase === 'settling') {
          emit(context, {
            type: 'progress',
            iteration: event.iteration,
            tokensInput: event.tokens?.input,
            tokensOutput: event.tokens?.output,
            cost: event.cost,
            lastMessage: event.lastText,
          });
        }
      },
      beforeFirstPrompt: () => assertAttachmentMetadata(sendObjective ? input.attachments : []),
      abortRemoteOnSignal: !input.resumeExisting,
    });
    void (isDesktopSession ? desktopCatalog.reconcile() : catalog.reconcile()).catch(() => undefined);
    emit(context, {
      type: 'progress',
      iteration: result.state.iterations,
      tokensInput: result.state.tokens.input,
      tokensOutput: result.state.tokens.output,
      cost: result.state.cost,
      lastMessage: result.state.lastText,
      detail: result.reason,
    });
    if (wallLimited) return { status: 'blocked', reason: 'Se alcanzó el límite de tiempo.', sessionId: result.sessionId };
    if (result.status === 'complete') {
      return {
        status: 'completed',
        reason: result.reason,
        sessionId: result.sessionId,
        iteration: result.state.iterations,
        tokensInput: result.state.tokens.input,
        tokensOutput: result.state.tokens.output,
        cost: result.state.cost,
        lastMessage: result.state.lastText,
      };
    }
    if (result.status === 'aborted') return { status: 'stopped', reason: result.reason, sessionId: result.sessionId };
    if (result.status === 'error') throw new Error(result.reason);
    return {
      status: 'blocked',
      reason: result.reason,
      sessionId: result.sessionId,
      iteration: result.state.iterations,
      tokensInput: result.state.tokens.input,
      tokensOutput: result.state.tokens.output,
      cost: result.state.cost,
      lastMessage: result.state.lastText,
    };
  } finally {
    clearTimeout(wallTimer);
    context.signal.removeEventListener('abort', relayAbort);
  }
}

export function createOpenCodeEngineAdapter(options: OpenCodeEngineAdapterOptions = {}): DesktopEngineAdapter {
  let sessionListener: ((sessions: OpenCodeSessionSummary[]) => void) | null = null;
  let catalogMode: 'desktop' | 'server' = 'desktop';
  const onCatalogLog = (level: 'debug' | 'info' | 'warn', message: string): void => {
    if (level === 'warn') process.stderr.write(`${message}\n`);
  };
  const catalog = options.serverCatalog ?? new OpenCodeSessionCatalog(onCatalogLog);
  const createServerCatalog = options.createServerCatalog ?? (() => new OpenCodeSessionCatalog(onCatalogLog));
  const desktopCatalog = options.desktopCatalog ?? new OpenCodeDesktopBridgeCatalog((level, message) => {
    if (level === 'warn') process.stderr.write(`${message}\n`);
  });
  catalog.setListener((sessions) => {
    if (catalogMode === 'server') sessionListener?.(sessions);
  });
  desktopCatalog.setListener((sessions) => {
    if (catalogMode === 'desktop') sessionListener?.(sessions);
  });
  return {
    doctor,
    run: (input, context) => run(input, context, catalog, desktopCatalog, options.agentModule ?? defaultAgentModule),
    async listSessions(input, listener) {
      sessionListener = listener;
      const requestedMode = input.attach === null ? 'desktop' : 'server';
      const sessions = requestedMode === 'desktop'
        ? (await desktopCatalog.connect(input)).sessions
        : (await catalog.connect(input)).sessions;
      catalogMode = requestedMode;
      return sessions;
    },
    async listModels(input): Promise<OpenCodeModelCatalog> {
      if (input.attach === null) {
        if (!desktopCatalog.connected) await desktopCatalog.connect(input);
        return desktopCatalog.models(input.workspace);
      }
      if (catalogMode === 'server' && catalog.matches(input)) return catalog.models();
      const transientCatalog = createServerCatalog();
      try {
        await transientCatalog.connect(input);
        return await transientCatalog.models();
      } finally {
        await transientCatalog.close();
      }
    },
    async getSessionContext(input): Promise<SessionContext> {
      const useDesktop = input.connectionMode === 'desktop-sidecar';
      if (useDesktop) {
        if (!desktopCatalog.connected) await desktopCatalog.connect(input);
        return desktopCatalog.context(input.sessionId, input.workspace, input.limit);
      }
      if (catalog.matches(input)) return catalog.context(input.sessionId, input.limit);
      const transientCatalog = createServerCatalog();
      try {
        await transientCatalog.connect(input);
        return await transientCatalog.context(input.sessionId, input.limit);
      } finally {
        await transientCatalog.close();
      }
    },
    async shutdown() {
      sessionListener = null;
      await Promise.all([catalog.close(), desktopCatalog.close()]);
    },
  };
}
