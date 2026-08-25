import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import {
  DESKTOP_ORIGIN,
  buildRunDeepLink,
  buildSessionDeepLink,
  parseDoctorInput,
  parseCopySessionLinkInput,
  parseDeepLink,
  parseOpenProjectInput,
  parseRunId,
  parseResumeRunInput,
  parseSessionContextInput,
  parseSessionConnectionInput,
  parseSetContinuousInput,
  parseStartRunInput,
  type DesktopEvent,
  type DeepLinkTarget,
  type DoctorInput,
  type DoctorResult,
  type SessionConnectionInput,
  type StartRunInput,
} from './contracts.js';
import { buildOpenCodeInternalSessionLink, buildOpenCodeProjectUrl } from './session-links.js';
import { assertAttachmentMetadata, inspectAttachments, parseDroppedPaths } from './attachments.js';
import { createOpenCodeEngineAdapter } from './engine-adapter.js';
import {
  RunManager,
  safeText,
  type DesktopEngineAdapter,
} from './run-manager.js';

const CHANNELS = {
  systemInfo: 'system:info',
  doctor: 'system:doctor',
  chooseWorkspace: 'workspace:choose',
  chooseBinary: 'binary:choose',
  chooseAttachments: 'attachments:choose',
  resolveDroppedAttachments: 'attachments:resolve-dropped',
  listRuns: 'runs:list',
  getRun: 'runs:get',
  listSessions: 'sessions:list',
  listModels: 'models:list',
  openOpenCodeProject: 'sessions:open-project',
  copyOpenCodeSessionLink: 'sessions:copy-internal-link',
  copyRunDeepLink: 'runs:copy-deep-link',
  copySessionDeepLink: 'sessions:copy-deep-link',
  getSessionContext: 'sessions:context',
  setContinuous: 'sessions:set-continuous',
  startRun: 'runs:start',
  resumeRun: 'runs:resume',
  stopRun: 'runs:stop',
  event: 'runs:event',
} as const;

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const squirrelStartup = require('electron-squirrel-startup') as boolean;
const desktopRoot = __dirname;
const rendererFiles = new Map<string, { file: string; contentType: string }>([
  ['/', { file: 'renderer/index.html', contentType: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'renderer/index.html', contentType: 'text/html; charset=utf-8' }],
  ['/app.css', { file: 'renderer/app.css', contentType: 'text/css; charset=utf-8' }],
  ['/app.js', { file: 'renderer/app.js', contentType: 'text/javascript; charset=utf-8' }],
]);

let mainWindow: BrowserWindow | null = null;
let runManager: RunManager | null = null;
let configuredAdapter: DesktopEngineAdapter | null = createOpenCodeEngineAdapter();
let allowQuit = false;
let shutdownStarted = false;
let desktopReady = false;
let rendererReady = false;
const pendingDeepLinks: DeepLinkTarget[] = [];
const MAX_PENDING_DEEP_LINKS = 20;

protocol.registerSchemesAsPrivileged([{
  scheme: 'opencode-infinite',
  privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false },
}]);
app.enableSandbox();

/** Integration hook for the real SSE-driven OpenCode engine adapter. */
export function configureDesktopEngineAdapter(adapter: DesktopEngineAdapter): void {
  configuredAdapter = adapter;
  if (runManager) runManager.setAdapter(adapter);
}

function safeError(error: unknown): string {
  return safeText(error);
}

function manager(): RunManager {
  if (!runManager) throw new Error('El gestor Desktop todavía no está listo.');
  return runManager;
}

function publish(event: DesktopEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(CHANNELS.event, event);
}

function focusMainWindow(): void {
  if (!desktopReady) return;
  if (!mainWindow) mainWindow = createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function flushDeepLinks(): void {
  if (!rendererReady || !mainWindow || mainWindow.isDestroyed()) return;
  for (const target of pendingDeepLinks.splice(0)) publish({ type: 'deep-link', target });
  focusMainWindow();
}

function queueDeepLink(raw: unknown): boolean {
  const target = parseDeepLink(raw);
  if (!target) return false;
  if (pendingDeepLinks.length >= MAX_PENDING_DEEP_LINKS) pendingDeepLinks.shift();
  pendingDeepLinks.push(target);
  if (desktopReady) {
    focusMainWindow();
    flushDeepLinks();
  }
  return true;
}

function queueDeepLinksFromArgv(argv: readonly string[]): boolean {
  return argv.reduce((accepted, argument) => queueDeepLink(argument) || accepted, false);
}

function registerDefaultProtocolClient(): void {
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient('opencode-infinite');
    return;
  }
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient('opencode-infinite', process.execPath, [path.resolve(process.argv[1])]);
  }
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const senderUrl = event.senderFrame?.url;
  if (!mainWindow || event.sender !== mainWindow.webContents || typeof senderUrl !== 'string') {
    throw new TypeError('Origen IPC no autorizado.');
  }
  let url: URL;
  try {
    url = new URL(senderUrl);
  } catch {
    throw new TypeError('Origen IPC no autorizado.');
  }
  if (url.protocol !== 'opencode-infinite:' || url.host !== 'app' || !rendererFiles.has(url.pathname)) {
    throw new TypeError('Origen IPC no autorizado.');
  }
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

function assertAbsolutePath(candidate: string, label: string): void {
  if (!path.isAbsolute(candidate)) throw new TypeError(`${label} debe ser una ruta absoluta.`);
}

async function assertStartPaths(input: StartRunInput): Promise<void> {
  assertAbsolutePath(input.workspace, 'El workspace');
  if (!await isDirectory(input.workspace)) throw new TypeError('El workspace no existe o no es un directorio.');
  if (input.binary !== null) {
    assertAbsolutePath(input.binary, 'El binario OpenCode');
    if (!await isFile(input.binary)) throw new TypeError('El binario OpenCode no existe o no es un archivo.');
  }
  await assertAttachmentMetadata(input.attachments);
}

async function assertConnectionPaths(input: SessionConnectionInput): Promise<void> {
  assertAbsolutePath(input.workspace, 'El workspace');
  if (!await isDirectory(input.workspace)) throw new TypeError('El workspace no existe o no es un directorio.');
  if (input.binary !== null) {
    assertAbsolutePath(input.binary, 'El binario OpenCode');
    if (!await isFile(input.binary)) throw new TypeError('El binario OpenCode no existe o no es un archivo.');
  }
}

async function doctor(input: DoctorInput): Promise<DoctorResult> {
  const result = await manager().doctor(input);
  const warnings = [...result.warnings];
  let workspaceReady = input.workspace === null;
  if (input.workspace !== null) {
    workspaceReady = path.isAbsolute(input.workspace) && await isDirectory(input.workspace);
    if (!workspaceReady) warnings.push('El workspace debe ser una ruta absoluta a un directorio existente.');
  }
  let binaryReady = result.binaryReady;
  if (input.binary !== null) {
    binaryReady = path.isAbsolute(input.binary) && await isFile(input.binary);
    if (!binaryReady) warnings.push('El binario seleccionado no existe o no es una ruta absoluta.');
  }
  return {
    ...result,
    ok: result.ok && workspaceReady && binaryReady !== false,
    workspaceReady,
    binaryReady,
    warnings: [...new Set(warnings)].slice(0, 20),
  };
}

function registerHandlers(): void {
  ipcMain.handle(CHANNELS.systemInfo, (event) => {
    assertTrustedSender(event);
    return { platform: process.platform, arch: process.arch, version: app.getVersion() };
  });
  ipcMain.handle(CHANNELS.doctor, async (event, raw: unknown) => {
    assertTrustedSender(event);
    return doctor(parseDoctorInput(raw));
  });
  ipcMain.handle(CHANNELS.chooseWorkspace, async (event) => {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Seleccionar workspace',
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle(CHANNELS.chooseBinary, async (event) => {
    assertTrustedSender(event);
    const filters = process.platform === 'win32'
      ? [{ name: 'OpenCode', extensions: ['exe', 'cmd'] }]
      : [{ name: 'OpenCode', extensions: ['*'] }];
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Seleccionar binario OpenCode',
      properties: ['openFile'],
      filters,
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle(CHANNELS.chooseAttachments, async (event) => {
    assertTrustedSender(event);
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Adjuntar archivos al objetivo',
      properties: ['openFile', 'multiSelections'],
    });
    return result.canceled ? [] : inspectAttachments(result.filePaths);
  });
  ipcMain.handle(CHANNELS.resolveDroppedAttachments, async (event, raw: unknown) => {
    assertTrustedSender(event);
    return inspectAttachments(parseDroppedPaths(raw));
  });
  ipcMain.handle(CHANNELS.listRuns, async (event) => {
    assertTrustedSender(event);
    return manager().listRuns();
  });
  ipcMain.handle(CHANNELS.getRun, async (event, raw: unknown) => {
    assertTrustedSender(event);
    return manager().getRun(parseRunId(raw));
  });
  ipcMain.handle(CHANNELS.listSessions, async (event, raw: unknown) => {
    assertTrustedSender(event);
    const input = parseSessionConnectionInput(raw);
    await assertConnectionPaths(input);
    return manager().listSessions(input);
  });
  ipcMain.handle(CHANNELS.listModels, async (event, raw: unknown) => {
    assertTrustedSender(event);
    const input = parseSessionConnectionInput(raw);
    await assertConnectionPaths(input);
    return manager().listModels(input);
  });
  ipcMain.handle(CHANNELS.openOpenCodeProject, async (event, raw: unknown) => {
    assertTrustedSender(event);
    const input = parseOpenProjectInput(raw);
    assertAbsolutePath(input.workspace, 'El workspace');
    if (!await isDirectory(input.workspace)) throw new TypeError('El workspace no existe o no es un directorio.');
    await shell.openExternal(buildOpenCodeProjectUrl(input.workspace));
  });
  ipcMain.handle(CHANNELS.copyOpenCodeSessionLink, (event, raw: unknown) => {
    assertTrustedSender(event);
    const input = parseCopySessionLinkInput(raw);
    clipboard.writeText(buildOpenCodeInternalSessionLink(input.sessionId));
  });
  ipcMain.handle(CHANNELS.copyRunDeepLink, (event, raw: unknown) => {
    assertTrustedSender(event);
    clipboard.writeText(buildRunDeepLink(parseRunId(raw)));
  });
  ipcMain.handle(CHANNELS.copySessionDeepLink, (event, raw: unknown) => {
    assertTrustedSender(event);
    const input = parseCopySessionLinkInput(raw);
    clipboard.writeText(buildSessionDeepLink(input.sessionId));
  });
  ipcMain.handle(CHANNELS.getSessionContext, async (event, raw: unknown) => {
    assertTrustedSender(event);
    const input = parseSessionContextInput(raw);
    await assertConnectionPaths(input);
    return manager().getSessionContext(input);
  });
  ipcMain.handle(CHANNELS.setContinuous, async (event, raw: unknown) => {
    assertTrustedSender(event);
    const input = parseSetContinuousInput(raw);
    if (input.enabled) await assertStartPaths(input.run);
    return manager().setContinuous(input);
  });
  ipcMain.handle(CHANNELS.startRun, async (event, raw: unknown) => {
    assertTrustedSender(event);
    const input = parseStartRunInput(raw);
    await assertStartPaths(input);
    return manager().start(input);
  });
  ipcMain.handle(CHANNELS.resumeRun, async (event, raw: unknown) => {
    assertTrustedSender(event);
    return manager().resume(parseResumeRunInput(raw));
  });
  ipcMain.handle(CHANNELS.stopRun, async (event, raw: unknown) => {
    assertTrustedSender(event);
    return manager().stop(parseRunId(raw));
  });
}

async function registerRendererProtocol(): Promise<void> {
  await protocol.handle('opencode-infinite', async (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app' || url.search.length > 0 || url.hash.length > 0) {
      return new Response('Not found', { status: 404 });
    }
    const resource = rendererFiles.get(url.pathname);
    if (!resource) return new Response('Not found', { status: 404 });
    try {
      const bytes = await readFile(path.join(desktopRoot, resource.file));
      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': resource.contentType,
          'Content-Security-Policy': CONTENT_SECURITY_POLICY,
          'Cache-Control': 'no-store',
          'Cross-Origin-Opener-Policy': 'same-origin',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (error) {
      return new Response(safeError(error), {
        status: 500,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
  });
}

function createWindow(): BrowserWindow {
  rendererReady = false;
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 640,
    icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
    show: false,
    backgroundColor: '#10110f',
    title: 'OpenCode Infinite',
    webPreferences: {
      preload: path.join(desktopRoot, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
      spellcheck: true,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => {
    try {
      const url = new URL(target);
      if (url.protocol === 'opencode-infinite:' && url.host === 'app' && rendererFiles.has(url.pathname)) return;
    } catch {
      // Denied below.
    }
    event.preventDefault();
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    process.stderr.write(`Renderer terminado: ${safeError(details.reason)}\n`);
  });
  window.setMenuBarVisibility(false);
  window.webContents.once('did-finish-load', () => {
    if (mainWindow !== window) return;
    rendererReady = true;
    flushDeepLinks();
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { if (mainWindow === window) mainWindow = null; });
  void window.loadURL(`${DESKTOP_ORIGIN}/index.html`);
  return window;
}

const hasSingleInstanceLock = !squirrelStartup && app.requestSingleInstanceLock();
if (squirrelStartup || !hasSingleInstanceLock) {
  app.quit();
} else {
  queueDeepLinksFromArgv(process.argv);
  app.on('open-url', (event, url) => {
    event.preventDefault();
    queueDeepLink(url);
  });
  app.on('second-instance', (_event, argv) => {
    queueDeepLinksFromArgv(argv);
    focusMainWindow();
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  app.whenReady().then(async () => {
    registerDefaultProtocolClient();
    Menu.setApplicationMenu(process.platform === 'darwin'
      ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
      : null);
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    await registerRendererProtocol();
    runManager = new RunManager(publish, app.getPath('userData'), configuredAdapter);
    await runManager.initialize();
    registerHandlers();
    desktopReady = true;
    mainWindow = createWindow();
  }).catch((error) => {
    process.stderr.write(`${safeError(error)}\n`);
    app.exit(1);
  });

  app.on('activate', () => {
    focusMainWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    if (allowQuit) return;
    if (!runManager) {
      allowQuit = true;
      return;
    }
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    void runManager.shutdown().finally(() => {
      allowQuit = true;
      app.quit();
    });
  });
}
