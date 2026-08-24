import type { DoctorInput, DoctorResult, StartRunInput } from './contracts.js';
import type { DesktopEngineAdapter, EngineRunContext, EngineRunResult } from './run-manager.js';

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

interface AgentModule {
  executeAgent(input: Record<string, unknown>, options: {
    signal: AbortSignal;
    log: Record<string, (message: string) => void>;
    onSession(sessionId: string): void;
    onTransport(state: 'connecting' | 'connected' | 'closed'): void;
    onState(event: {
      phase: 'working' | 'continuing' | 'settling';
      iteration: number;
      tokens?: { input: number; output: number };
      cost?: number;
      lastText?: string;
    }): void;
  }): Promise<AgentResult>;
}

interface ServerModule {
  findBinary(explicit?: string | null): string;
  health(base: string): Promise<string | null>;
}

const agentModule = require('../agent.js') as AgentModule;
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

async function run(input: StartRunInput, context: EngineRunContext): Promise<EngineRunResult> {
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
  try {
    const ref = input.sessionRef;
    const result = await agentModule.executeAgent({
      dir: input.workspace,
      prompt: input.task,
      session: ref && ref.startsWith('ses_') ? ref : undefined,
      deeplink: ref && ref.startsWith('oc://') ? ref : undefined,
      title: input.name,
      model: input.model,
      agent: input.agent,
      binary: input.binary,
      attach: input.attach,
      maxIterations: input.maxIterations,
      stallTimeoutMin: input.stallMinutes,
      turnHardTimeoutMin: Math.max(input.stallMinutes, Math.ceil(input.maxHours * 60)),
      sentinel: input.sentinel,
      noTodos: !input.todoDetection,
      autoApprove: input.autoApprove,
      keepServer: false,
      exclusiveServer: input.attach === null,
    }, {
      signal: controller.signal,
      log: logger(context),
      onSession: (sessionId) => emit(context, { type: 'session', sessionId }),
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
        emit(context, {
          type: 'progress',
          iteration: event.iteration,
          tokensInput: event.tokens?.input,
          tokensOutput: event.tokens?.output,
          cost: event.cost,
          lastMessage: event.lastText,
        });
      },
    });
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

export function createOpenCodeEngineAdapter(): DesktopEngineAdapter {
  return { doctor, run };
}
