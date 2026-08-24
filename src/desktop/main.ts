import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  session,
  type IpcMainInvokeEvent,
} from 'electron';
import {
  DESKTOP_ORIGIN,
  parseDoctorInput,
  parseRunId,
  parseStartRunInput,
  type DesktopEvent,
  type DoctorInput,
  type DoctorResult,
  type StartRunInput,
} from './contracts.js';
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
  listRuns: 'runs:list',
  getRun: 'runs:get',
  startRun: 'runs:start',
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
  ['/contracts.js', { file: 'contracts.js', contentType: 'text/javascript; charset=utf-8' }],
]);

let mainWindow: BrowserWindow | null = null;
let runManager: RunManager | null = null;
let configuredAdapter: DesktopEngineAdapter | null = createOpenCodeEngineAdapter();
let allowQuit = false;
let shutdownStarted = false;

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
  ipcMain.handle(CHANNELS.listRuns, async (event) => {
    assertTrustedSender(event);
    return manager().listRuns();
  });
  ipcMain.handle(CHANNELS.getRun, async (event, raw: unknown) => {
    assertTrustedSender(event);
    return manager().getRun(parseRunId(raw));
  });
  ipcMain.handle(CHANNELS.startRun, async (event, raw: unknown) => {
    assertTrustedSender(event);
    const input = parseStartRunInput(raw);
    await assertStartPaths(input);
    return manager().start(input);
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
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { if (mainWindow === window) mainWindow = null; });
  void window.loadURL(`${DESKTOP_ORIGIN}/index.html`);
  return window;
}

const hasSingleInstanceLock = !squirrelStartup && app.requestSingleInstanceLock();
if (squirrelStartup || !hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) mainWindow = createWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(process.platform === 'darwin'
      ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
      : null);
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    await registerRendererProtocol();
    runManager = new RunManager(publish, app.getPath('userData'), configuredAdapter);
    await runManager.initialize();
    registerHandlers();
    mainWindow = createWindow();
  }).catch((error) => {
    process.stderr.write(`${safeError(error)}\n`);
    app.exit(1);
  });

  app.on('activate', () => {
    if (!mainWindow) mainWindow = createWindow();
    else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    if (allowQuit || !runManager?.hasActiveRuns) return;
    event.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    void runManager.shutdown().finally(() => {
      allowQuit = true;
      app.quit();
    });
  });
}
