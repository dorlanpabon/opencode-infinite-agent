import type {
  DesktopApi,
  DesktopEvent,
  DoctorResult,
  LogLevel,
  RunState,
  RunStatus,
  StartRunInput,
} from '../contracts.js';

declare global {
  interface Window {
    opencodeInfinite: DesktopApi;
  }
}

const api = window.opencodeInfinite;
if (!api) throw new Error('El bridge seguro de OpenCode Infinite no está disponible.');

const ACTIVE_STATUSES = new Set<RunStatus>([
  'initializing', 'connecting', 'working', 'retrying', 'settling', 'continuing', 'stopping',
]);
const SUCCESS_STATUSES = new Set<RunStatus>(['completed']);
const ERROR_STATUSES = new Set<RunStatus>(['blocked', 'failed']);

const statusLabels: Record<RunStatus, string> = {
  initializing: 'Inicializando',
  connecting: 'Conectando',
  working: 'Trabajando',
  retrying: 'Reintentando',
  settling: 'Asentando',
  continuing: 'Evaluando',
  stopping: 'Deteniendo',
  completed: 'Completada',
  blocked: 'Bloqueada',
  stopped: 'Detenida',
  failed: 'Fallida',
};

const sseLabels = {
  disconnected: 'Desconectado',
  connecting: 'Conectando',
  connected: 'Conectado',
  reconnecting: 'Reconectando',
  closed: 'Cerrado',
} as const;

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Elemento requerido no encontrado: ${id}`);
  return value as T;
}

const ui = {
  doctorButton: element<HTMLButtonElement>('doctor-button'),
  doctorSignal: element<HTMLSpanElement>('doctor-signal'),
  doctorLabel: element<HTMLElement>('doctor-label'),
  newRunButton: element<HTMLButtonElement>('new-run-button'),
  newRunShortcut: element<HTMLElement>('new-run-shortcut'),
  emptyNewRunButton: element<HTMLButtonElement>('empty-new-run-button'),
  runCount: element<HTMLElement>('run-count'),
  runList: element<HTMLElement>('run-list'),
  runListEmpty: element<HTMLElement>('run-list-empty'),
  appVersion: element<HTMLElement>('app-version'),
  workspaceMain: element<HTMLElement>('workspace-main'),
  emptyState: element<HTMLElement>('empty-state'),
  runDetail: element<HTMLElement>('run-detail'),
  runStatus: element<HTMLElement>('run-status'),
  runUpdated: element<HTMLElement>('run-updated'),
  runName: element<HTMLElement>('run-name'),
  runTask: element<HTMLElement>('run-task'),
  stopRunButton: element<HTMLButtonElement>('stop-run-button'),
  metricIterations: element<HTMLElement>('metric-iterations'),
  iterationProgress: element<HTMLProgressElement>('iteration-progress'),
  metricSse: element<HTMLElement>('metric-sse'),
  metricTokens: element<HTMLElement>('metric-tokens'),
  metricTokenDetail: element<HTMLElement>('metric-token-detail'),
  metricCost: element<HTMLElement>('metric-cost'),
  metricRuntime: element<HTMLElement>('metric-runtime'),
  eventClock: element<HTMLElement>('event-clock'),
  cycleTrack: element<HTMLOListElement>('cycle-track'),
  lastEvent: element<HTMLElement>('last-event'),
  lastMessage: element<HTMLElement>('last-message'),
  runReason: element<HTMLElement>('run-reason'),
  runSentinel: element<HTMLElement>('run-sentinel'),
  runTodos: element<HTMLElement>('run-todos'),
  runPermissions: element<HTMLElement>('run-permissions'),
  inspectorTab: element<HTMLButtonElement>('inspector-tab'),
  logsTab: element<HTMLButtonElement>('logs-tab'),
  logCount: element<HTMLElement>('log-count'),
  inspectorPanel: element<HTMLElement>('inspector-panel'),
  logsPanel: element<HTMLElement>('logs-panel'),
  inspectorDoctorButton: element<HTMLButtonElement>('inspector-doctor-button'),
  inspectEngine: element<HTMLElement>('inspect-engine'),
  inspectMode: element<HTMLElement>('inspect-mode'),
  inspectEndpoint: element<HTMLElement>('inspect-endpoint'),
  inspectVersion: element<HTMLElement>('inspect-version'),
  doctorWarnings: element<HTMLUListElement>('doctor-warnings'),
  inspectRunId: element<HTMLElement>('inspect-run-id'),
  inspectSession: element<HTMLElement>('inspect-session'),
  inspectWorkspace: element<HTMLElement>('inspect-workspace'),
  inspectModel: element<HTMLElement>('inspect-model'),
  inspectAgent: element<HTMLElement>('inspect-agent'),
  inspectLimit: element<HTMLElement>('inspect-limit'),
  clearLogsButton: element<HTMLButtonElement>('clear-logs-button'),
  logList: element<HTMLOListElement>('log-list'),
  logsEmpty: element<HTMLElement>('logs-empty'),
  runDialog: element<HTMLDialogElement>('run-dialog'),
  form: element<HTMLFormElement>('run-form'),
  dialogCloseButton: element<HTMLButtonElement>('dialog-close-button'),
  dialogCancelButton: element<HTMLButtonElement>('dialog-cancel-button'),
  taskInput: element<HTMLTextAreaElement>('task-input'),
  taskCount: element<HTMLElement>('task-count'),
  workspaceInput: element<HTMLInputElement>('workspace-input'),
  workspacePickerButton: element<HTMLButtonElement>('workspace-picker-button'),
  nameInput: element<HTMLInputElement>('name-input'),
  maxIterationsInput: element<HTMLInputElement>('max-iterations-input'),
  maxHoursInput: element<HTMLInputElement>('max-hours-input'),
  stallMinutesInput: element<HTMLInputElement>('stall-minutes-input'),
  sentinelInput: element<HTMLInputElement>('sentinel-input'),
  advancedSettings: element<HTMLDetailsElement>('advanced-settings'),
  sessionInput: element<HTMLInputElement>('session-input'),
  attachInput: element<HTMLInputElement>('attach-input'),
  modelInput: element<HTMLInputElement>('model-input'),
  agentInput: element<HTMLInputElement>('agent-input'),
  binaryInput: element<HTMLInputElement>('binary-input'),
  binaryPickerButton: element<HTMLButtonElement>('binary-picker-button'),
  todosInput: element<HTMLInputElement>('todos-input'),
  autoApproveInput: element<HTMLInputElement>('auto-approve-input'),
  autoApproveConfirmationRow: element<HTMLElement>('auto-approve-confirmation-row'),
  autoApproveConfirmationInput: element<HTMLInputElement>('auto-approve-confirmation-input'),
  dialogDoctorButton: element<HTMLButtonElement>('dialog-doctor-button'),
  dialogDoctorSignal: element<HTMLSpanElement>('dialog-doctor-signal'),
  dialogDoctorLabel: element<HTMLElement>('dialog-doctor-label'),
  dialogDoctorDetail: element<HTMLElement>('dialog-doctor-detail'),
  formError: element<HTMLElement>('form-error'),
  runSubmitButton: element<HTMLButtonElement>('run-submit-button'),
  toastRegion: element<HTMLElement>('toast-region'),
  liveRegion: element<HTMLElement>('live-region'),
};

let runs: RunState[] = [];
let selectedRunId: string | null = null;
let logs: LogEntry[] = [];
let doctorResult: DoctorResult | null = null;

function selectedRun(): RunState | null {
  return selectedRunId ? runs.find((run) => run.runId === selectedRunId) ?? null : null;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Ocurrió un error inesperado.';
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(value);
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

function formatRelative(value: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(value));
  if (!Number.isFinite(elapsed)) return '—';
  if (elapsed < 60_000) return 'ahora';
  if (elapsed < 3_600_000) return `hace ${Math.floor(elapsed / 60_000)} min`;
  if (elapsed < 86_400_000) return `hace ${Math.floor(elapsed / 3_600_000)} h`;
  return formatDate(value);
}

function runtime(run: RunState): string {
  const end = run.completedAt ? Date.parse(run.completedAt) : Date.now();
  const start = Date.parse(run.createdAt);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return '—';
  const minutes = Math.max(0, Math.floor((end - start) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

function announce(message: string): void {
  ui.liveRegion.textContent = '';
  window.requestAnimationFrame(() => { ui.liveRegion.textContent = message; });
}

function toast(message: string, error = false): void {
  const node = document.createElement('div');
  node.className = 'toast';
  node.dataset.error = String(error);
  node.textContent = message;
  ui.toastRegion.append(node);
  window.setTimeout(() => node.remove(), 4_500);
}

function setSignal(node: HTMLElement, state: 'pending' | 'ok' | 'error'): void {
  node.classList.remove('signal--pending', 'signal--ok', 'signal--error');
  node.classList.add(`signal--${state}`);
}

function setFormError(message: string | null): void {
  ui.formError.hidden = message === null;
  ui.formError.textContent = message ?? '';
}

function appendLog(level: LogLevel, message: string, timestamp = new Date().toISOString()): void {
  logs.push({ level, message, timestamp });
  if (logs.length > 500) logs = logs.slice(-500);
  renderLogs();
}

function renderLogs(): void {
  const fragment = document.createDocumentFragment();
  for (const entry of logs) {
    const item = document.createElement('li');
    item.className = 'log-item';
    item.dataset.level = entry.level;
    const time = document.createElement('time');
    const date = new Date(entry.timestamp);
    time.dateTime = entry.timestamp;
    time.textContent = Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date)
      : '--:--';
    const message = document.createElement('span');
    message.textContent = entry.message;
    item.append(time, message);
    fragment.append(item);
  }
  ui.logList.replaceChildren(fragment);
  ui.logCount.textContent = String(logs.length);
  ui.logsEmpty.hidden = logs.length > 0;
  if (logs.length > 0) ui.logList.scrollTop = ui.logList.scrollHeight;
}

function upsertRun(run: RunState): void {
  const index = runs.findIndex((candidate) => candidate.runId === run.runId);
  if (index < 0) runs.push(run);
  else runs[index] = run;
  runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!selectedRunId) selectedRunId = run.runId;
}

function renderRunList(): void {
  const fragment = document.createDocumentFragment();
  for (const run of runs) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'run-item';
    button.classList.toggle('is-selected', run.runId === selectedRunId);
    button.setAttribute('aria-current', run.runId === selectedRunId ? 'true' : 'false');

    const head = document.createElement('span');
    head.className = 'run-item-head';
    const title = document.createElement('span');
    title.className = 'run-item-title';
    title.textContent = run.name;
    const dot = document.createElement('span');
    dot.className = 'run-item-dot';
    dot.dataset.active = String(ACTIVE_STATUSES.has(run.status));
    dot.dataset.success = String(SUCCESS_STATUSES.has(run.status));
    dot.setAttribute('aria-hidden', 'true');
    head.append(title, dot);

    const meta = document.createElement('span');
    meta.className = 'run-item-meta';
    const status = document.createElement('span');
    status.textContent = statusLabels[run.status];
    const updated = document.createElement('span');
    updated.textContent = formatRelative(run.updatedAt);
    meta.append(status, updated);
    button.append(head, meta);
    button.addEventListener('click', () => {
      selectedRunId = run.runId;
      render();
      ui.workspaceMain.focus();
    });
    fragment.append(button);
  }
  ui.runList.replaceChildren(fragment);
  ui.runCount.textContent = String(runs.length);
  ui.runCount.setAttribute('aria-label', `${runs.length} ejecuciones`);
  ui.runListEmpty.hidden = runs.length > 0;
}

function phaseIndex(status: RunStatus): number {
  switch (status) {
    case 'initializing':
    case 'connecting': return 0;
    case 'working':
    case 'retrying': return 1;
    case 'settling': return 2;
    case 'continuing':
    case 'completed':
    case 'blocked':
    case 'stopped':
    case 'failed':
    case 'stopping': return 3;
  }
}

function renderCycle(run: RunState): void {
  const current = phaseIndex(run.status);
  const terminal = !ACTIVE_STATUSES.has(run.status);
  const items = [...ui.cycleTrack.querySelectorAll<HTMLElement>('li')];
  items.forEach((item, index) => {
    item.dataset.current = String(!terminal && index === current);
    item.dataset.complete = String(index < current || (terminal && index <= current));
  });
}

function renderSelectedRun(): void {
  const run = selectedRun();
  ui.emptyState.hidden = run !== null;
  ui.runDetail.hidden = run === null;
  if (!run) {
    ui.inspectRunId.textContent = '—';
    ui.inspectSession.textContent = '—';
    ui.inspectWorkspace.textContent = '—';
    ui.inspectModel.textContent = 'Predeterminado';
    ui.inspectAgent.textContent = 'Predeterminado';
    ui.inspectLimit.textContent = '—';
    return;
  }

  const active = ACTIVE_STATUSES.has(run.status);
  const success = SUCCESS_STATUSES.has(run.status);
  const error = ERROR_STATUSES.has(run.status);
  ui.runStatus.textContent = statusLabels[run.status];
  ui.runStatus.dataset.active = String(active);
  ui.runStatus.dataset.success = String(success);
  ui.runStatus.dataset.error = String(error);
  ui.runUpdated.textContent = `Actualizada ${formatRelative(run.updatedAt)}`;
  ui.runName.textContent = run.name;
  ui.runTask.textContent = run.task;
  ui.stopRunButton.hidden = !active;
  ui.stopRunButton.disabled = run.status === 'stopping';

  ui.metricIterations.textContent = `${formatInteger(run.iteration)} / ${formatInteger(run.maxIterations)}`;
  ui.iterationProgress.max = Math.max(1, run.maxIterations);
  ui.iterationProgress.value = Math.min(run.iteration, run.maxIterations);
  ui.metricSse.textContent = sseLabels[run.sseState];
  ui.metricSse.dataset.connected = String(run.sseState === 'connected');
  ui.metricTokens.textContent = formatInteger(run.tokensInput + run.tokensOutput);
  ui.metricTokenDetail.textContent = `${formatInteger(run.tokensInput)} entrada · ${formatInteger(run.tokensOutput)} salida`;
  ui.metricCost.textContent = `$${run.cost.toFixed(4)}`;
  ui.metricRuntime.textContent = runtime(run);
  ui.eventClock.textContent = formatDate(run.updatedAt);
  ui.lastEvent.textContent = run.lastEvent ?? 'Esperando actividad.';
  ui.lastMessage.textContent = run.lastMessage ?? 'Aún no hay una respuesta completada.';
  ui.runReason.textContent = run.reason ?? 'La ejecución todavía está activa.';
  ui.runSentinel.textContent = run.sentinel;
  ui.runTodos.textContent = run.todoDetection ? 'Activados' : 'Desactivados';
  ui.runPermissions.textContent = run.autoApprove ? 'Autoaprobar esta sesión' : 'Confirmación manual';
  renderCycle(run);

  ui.inspectRunId.textContent = run.runId;
  ui.inspectRunId.title = run.runId;
  ui.inspectSession.textContent = run.sessionId ?? run.sessionRef ?? 'Pendiente';
  ui.inspectSession.title = ui.inspectSession.textContent;
  ui.inspectWorkspace.textContent = run.workspace;
  ui.inspectWorkspace.title = run.workspace;
  ui.inspectModel.textContent = run.model ?? 'Predeterminado';
  ui.inspectAgent.textContent = run.agent ?? 'Predeterminado';
  ui.inspectLimit.textContent = `${run.maxIterations} iter. · ${run.maxHours} h · ${run.stallMinutes} min inactividad`;
}

function render(): void {
  if (selectedRunId && !runs.some((run) => run.runId === selectedRunId)) selectedRunId = runs[0]?.runId ?? null;
  if (!selectedRunId && runs.length > 0) selectedRunId = runs[0]!.runId;
  renderRunList();
  renderSelectedRun();
}

function renderDoctor(result: DoctorResult): void {
  const state = result.ok ? 'ok' : 'error';
  setSignal(ui.doctorSignal, state);
  setSignal(ui.dialogDoctorSignal, state);
  ui.doctorLabel.textContent = result.ok ? 'Listo para ejecutar' : 'Revisión necesaria';
  ui.dialogDoctorLabel.textContent = result.ok ? 'Conexión verificada' : 'Configuración incompleta';
  ui.dialogDoctorDetail.textContent = result.warnings[0] ?? `${result.mode} · ${result.serverVersion ?? 'versión pendiente'}`;
  ui.inspectEngine.textContent = result.engineAvailable ? 'Disponible' : 'No integrado';
  ui.inspectMode.textContent = result.mode;
  ui.inspectEndpoint.textContent = result.endpoint ?? 'Detección automática';
  ui.inspectEndpoint.title = result.endpoint ?? '';
  ui.inspectVersion.textContent = result.serverVersion ?? '—';

  const fragment = document.createDocumentFragment();
  for (const warning of result.warnings) {
    const item = document.createElement('li');
    item.textContent = warning;
    fragment.append(item);
  }
  ui.doctorWarnings.replaceChildren(fragment);
}

async function runDoctor(showToast = true): Promise<void> {
  ui.doctorButton.disabled = true;
  ui.inspectorDoctorButton.disabled = true;
  ui.dialogDoctorButton.disabled = true;
  setSignal(ui.doctorSignal, 'pending');
  setSignal(ui.dialogDoctorSignal, 'pending');
  ui.doctorLabel.textContent = 'Comprobando…';
  ui.dialogDoctorLabel.textContent = 'Comprobando…';
  try {
    const run = selectedRun();
    const result = await api.doctor(
      ui.workspaceInput.value.trim() || run?.workspace || null,
      ui.binaryInput.value.trim() || run?.binary || null,
      ui.attachInput.value.trim() || run?.attach || null,
    );
    doctorResult = result;
    renderDoctor(result);
    appendLog(result.ok ? 'info' : 'warn', result.ok
      ? 'Diagnóstico OpenCode completado.'
      : result.warnings[0] ?? 'El diagnóstico requiere atención.');
    if (showToast) toast(result.ok ? 'OpenCode está listo.' : 'Revisa la configuración de OpenCode.', !result.ok);
    return;
  } catch (error) {
    const message = errorText(error);
    setSignal(ui.doctorSignal, 'error');
    setSignal(ui.dialogDoctorSignal, 'error');
    ui.doctorLabel.textContent = 'No disponible';
    ui.dialogDoctorLabel.textContent = 'Diagnóstico fallido';
    ui.dialogDoctorDetail.textContent = message;
    ui.inspectEngine.textContent = 'Error';
    appendLog('error', `Diagnóstico: ${message}`);
    if (showToast) toast(message, true);
  } finally {
    ui.doctorButton.disabled = false;
    ui.inspectorDoctorButton.disabled = false;
    ui.dialogDoctorButton.disabled = false;
  }
}

function updateAutoApprove(): void {
  const enabled = ui.autoApproveInput.checked;
  ui.autoApproveConfirmationRow.hidden = !enabled;
  ui.autoApproveConfirmationInput.required = enabled;
  if (!enabled) ui.autoApproveConfirmationInput.checked = false;
}

function openRunDialog(): void {
  const run = selectedRun();
  const workspace = run?.workspace ?? ui.workspaceInput.value;
  const binary = run?.binary ?? ui.binaryInput.value;
  const attach = run?.attach ?? ui.attachInput.value;
  ui.form.reset();
  ui.workspaceInput.value = workspace;
  ui.binaryInput.value = binary ?? '';
  ui.attachInput.value = attach ?? '';
  ui.taskCount.textContent = '0 / 8000';
  ui.advancedSettings.open = false;
  updateAutoApprove();
  setFormError(null);
  if (!ui.runDialog.open) ui.runDialog.showModal();
  window.setTimeout(() => ui.taskInput.focus(), 0);
}

function closeRunDialog(): void {
  if (ui.runDialog.open) ui.runDialog.close();
}

function startInput(): StartRunInput {
  return {
    task: ui.taskInput.value.trim(),
    workspace: ui.workspaceInput.value.trim(),
    name: ui.nameInput.value.trim() || null,
    sessionRef: ui.sessionInput.value.trim() || null,
    model: ui.modelInput.value.trim() || null,
    agent: ui.agentInput.value.trim() || null,
    binary: ui.binaryInput.value.trim() || null,
    attach: ui.attachInput.value.trim() || null,
    maxIterations: ui.maxIterationsInput.valueAsNumber,
    maxHours: ui.maxHoursInput.valueAsNumber,
    stallMinutes: ui.stallMinutesInput.valueAsNumber,
    sentinel: ui.sentinelInput.value.trim(),
    todoDetection: ui.todosInput.checked,
    autoApprove: ui.autoApproveInput.checked,
    autoApproveConfirmation: ui.autoApproveInput.checked && ui.autoApproveConfirmationInput.checked,
  };
}

async function submitRun(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  setFormError(null);
  if (!ui.form.checkValidity()) {
    ui.form.reportValidity();
    return;
  }
  ui.runSubmitButton.disabled = true;
  ui.runSubmitButton.textContent = 'Iniciando…';
  try {
    const receipt = await api.startRun(startInput());
    selectedRunId = receipt.runId;
    closeRunDialog();
    appendLog('info', `Ejecución ${receipt.runId} iniciada.`);
    toast('Supervisor iniciado.');
    announce('Ejecución iniciada.');
    const state = await api.getRun(receipt.runId);
    upsertRun(state);
    render();
  } catch (error) {
    const message = errorText(error);
    setFormError(message);
    appendLog('error', `Inicio: ${message}`);
  } finally {
    ui.runSubmitButton.disabled = false;
    ui.runSubmitButton.textContent = 'Iniciar supervisor';
  }
}

async function chooseWorkspace(): Promise<void> {
  ui.workspacePickerButton.disabled = true;
  try {
    const workspace = await api.chooseWorkspace();
    if (workspace) {
      ui.workspaceInput.value = workspace;
      announce('Workspace seleccionado.');
    }
  } catch (error) {
    setFormError(errorText(error));
  } finally {
    ui.workspacePickerButton.disabled = false;
  }
}

async function chooseBinary(): Promise<void> {
  ui.binaryPickerButton.disabled = true;
  try {
    const binary = await api.chooseBinary();
    if (binary) {
      ui.binaryInput.value = binary;
      announce('Binario OpenCode seleccionado.');
    }
  } catch (error) {
    setFormError(errorText(error));
  } finally {
    ui.binaryPickerButton.disabled = false;
  }
}

async function stopSelectedRun(): Promise<void> {
  const run = selectedRun();
  if (!run || !ACTIVE_STATUSES.has(run.status)) return;
  ui.stopRunButton.disabled = true;
  try {
    await api.stopRun(run.runId);
    appendLog('info', `Detención solicitada para ${run.runId}.`);
    toast('Detención segura solicitada.');
  } catch (error) {
    const message = errorText(error);
    appendLog('error', `Detención: ${message}`);
    toast(message, true);
  } finally {
    ui.stopRunButton.disabled = false;
  }
}

function handleDesktopEvent(event: DesktopEvent): void {
  switch (event.type) {
    case 'run-changed':
      upsertRun(event.run);
      render();
      break;
    case 'operation-finished':
      upsertRun(event.run);
      appendLog(event.run.status === 'completed' ? 'info' : 'warn', `${event.run.name}: ${statusLabels[event.run.status]}.`);
      toast(`${event.run.name}: ${statusLabels[event.run.status].toLowerCase()}.`, ERROR_STATUSES.has(event.run.status));
      announce(`Ejecución ${statusLabels[event.run.status].toLowerCase()}.`);
      render();
      break;
    case 'operation-error':
      appendLog('error', `${event.error.code}: ${event.error.message}`);
      toast(event.error.message, true);
      announce('La ejecución terminó con un error.');
      break;
    case 'log':
      appendLog(event.level, event.message, event.timestamp);
      break;
  }
}

function setTab(tab: 'inspector' | 'logs', focus = false): void {
  const inspector = tab === 'inspector';
  ui.inspectorTab.classList.toggle('is-active', inspector);
  ui.logsTab.classList.toggle('is-active', !inspector);
  ui.inspectorTab.setAttribute('aria-selected', String(inspector));
  ui.logsTab.setAttribute('aria-selected', String(!inspector));
  ui.inspectorTab.tabIndex = inspector ? 0 : -1;
  ui.logsTab.tabIndex = inspector ? -1 : 0;
  ui.inspectorPanel.hidden = !inspector;
  ui.logsPanel.hidden = inspector;
  if (focus) (inspector ? ui.inspectorTab : ui.logsTab).focus();
}

function tabKeydown(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  setTab(event.key === 'ArrowLeft' || event.key === 'Home' ? 'inspector' : 'logs', true);
}

function wireEvents(): () => void {
  ui.newRunButton.addEventListener('click', openRunDialog);
  ui.emptyNewRunButton.addEventListener('click', openRunDialog);
  ui.dialogCloseButton.addEventListener('click', closeRunDialog);
  ui.dialogCancelButton.addEventListener('click', closeRunDialog);
  ui.form.addEventListener('submit', (event) => { void submitRun(event); });
  ui.taskInput.addEventListener('input', () => {
    ui.taskCount.textContent = `${ui.taskInput.value.length} / 8000`;
  });
  ui.workspacePickerButton.addEventListener('click', () => { void chooseWorkspace(); });
  ui.binaryPickerButton.addEventListener('click', () => { void chooseBinary(); });
  ui.autoApproveInput.addEventListener('change', updateAutoApprove);
  ui.doctorButton.addEventListener('click', () => { void runDoctor(); });
  ui.inspectorDoctorButton.addEventListener('click', () => { void runDoctor(); });
  ui.dialogDoctorButton.addEventListener('click', () => { void runDoctor(); });
  ui.stopRunButton.addEventListener('click', () => { void stopSelectedRun(); });
  ui.clearLogsButton.addEventListener('click', () => {
    logs = [];
    renderLogs();
    announce('Registro limpiado.');
  });
  ui.inspectorTab.addEventListener('click', () => setTab('inspector'));
  ui.logsTab.addEventListener('click', () => setTab('logs'));
  ui.inspectorTab.addEventListener('keydown', tabKeydown);
  ui.logsTab.addEventListener('keydown', tabKeydown);
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      openRunDialog();
    }
  });
  return api.onEvent(handleDesktopEvent);
}

async function initialize(): Promise<void> {
  setTab('inspector');
  renderLogs();
  try {
    const info = await api.systemInfo();
    ui.appVersion.textContent = `v${info.version} · ${info.platform}/${info.arch}`;
    ui.newRunShortcut.textContent = info.platform === 'darwin' ? '⌘ N' : 'Ctrl N';
  } catch (error) {
    ui.appVersion.textContent = 'Versión no disponible';
    appendLog('warn', `Sistema: ${errorText(error)}`);
  }
  try {
    runs = await api.listRuns();
    selectedRunId = runs[0]?.runId ?? null;
    render();
  } catch (error) {
    appendLog('error', `Historial: ${errorText(error)}`);
    render();
  }
  await runDoctor(false);
}

const unsubscribe = wireEvents();
window.addEventListener('beforeunload', unsubscribe, { once: true });
void initialize();

// Retain the last result for the inspector without persisting connection secrets.
void doctorResult;
