import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { packagerConfig } = require('../forge.config.cjs');
const { executableName, name: packageName } = packagerConfig;
const packageRoot = path.join(root, 'out', `${packageName}-${process.platform}-${process.arch}`);
const defaultExecutablePath = process.platform === 'win32'
  ? path.join(packageRoot, `${executableName}.exe`)
  : process.platform === 'darwin'
    ? path.join(packageRoot, `${packageName}.app`, 'Contents', 'MacOS', executableName)
    : path.join(packageRoot, executableName);
const executablePath = await resolveExecutablePath(process.argv.slice(2), defaultExecutablePath);
const userDataDirectory = await mkdtemp(path.join(os.tmpdir(), 'opencode-infinite-smoke-'));
const port = await reservePort();
const desktop = spawn(executablePath, [
  '--remote-debugging-address=127.0.0.1',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDirectory}`,
], { detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
let stderr = '';
desktop.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-8192); });
let browser;
try {
  browser = await connectToDesktop(port, desktop, () => stderr);
  const window = await findAppWindow(browser);
  await window.waitForLoadState('domcontentloaded');
  assert.equal(await window.title(), 'OpenCode Infinite');
  assert.equal(await window.url(), 'opencode-infinite://app/index.html');
  const system = await window.evaluate(() => window.opencodeInfinite.systemInfo());
  assert.deepEqual({ platform: system.platform, arch: system.arch }, { platform: process.platform, arch: process.arch });
  assert.match(system.version, /^\d+\.\d+\.\d+/u);
  assert.equal(await window.locator('#auto-approve-input').isChecked(), false);
  await window.waitForSelector('#empty-state:not([hidden])');
  const initialFit = await layoutSnapshot(window);
  assert.equal(initialFit.canScrollX, false);
  assert.equal(initialFit.canScrollY, false);
  assert.equal(initialFit.regions.every((region) => region.visible && region.inViewport), true);

  const qaDirectory = process.env.QA_SCREENSHOT_DIR || path.join(root, 'out', 'qa');
  await mkdir(qaDirectory, { recursive: true });
  await window.screenshot({ path: path.join(qaDirectory, 'desktop-initial.png') });

  await window.locator('#new-run-button').click();
  assert.equal(await window.locator('#run-dialog').evaluate((dialog) => dialog.open), true);
  const dialogFit = await window.locator('#run-dialog').evaluate((dialog) => {
    const rect = dialog.getBoundingClientRect();
    return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
  });
  assert.equal(dialogFit, true);
  await window.locator('#advanced-settings').evaluate((details) => { details.open = true; });
  await window.locator('#auto-approve-input').check();
  assert.equal(await window.locator('#auto-approve-confirmation-row').isVisible(), true);
  assert.equal(await window.locator('#auto-approve-confirmation-input').isChecked(), false);
  await window.locator('#auto-approve-input').uncheck();
  assert.equal(await window.locator('#auto-approve-confirmation-row').isHidden(), true);

  await window.locator('#task-input').fill('Validación de seguridad sin ejecutar OpenCode');
  await window.locator('#workspace-input').fill(userDataDirectory);
  await window.locator('#attach-input').fill('https://example.com');
  const invalidFields = await window.locator('#run-form').evaluate((form) => [...form.elements]
    .filter((element) => 'checkValidity' in element && !element.checkValidity())
    .map((element) => ({ id: element.id, message: element.validationMessage })));
  assert.deepEqual(invalidFields, []);
  await window.locator('#run-form').evaluate((form) => form.requestSubmit());
  await window.locator('#form-error').waitFor({ state: 'visible' });
  assert.match(await window.locator('#form-error').innerText(), /loopback|servidor local/iu);
  await window.screenshot({ path: path.join(qaDirectory, 'desktop-dialog-security.png') });
  await window.locator('#dialog-close-button').click();

  await window.locator('#logs-tab').click();
  assert.equal(await window.locator('#logs-panel').isVisible(), true);
  assert.equal(await window.locator('#inspector-panel').isHidden(), true);
  await window.locator('#inspector-tab').click();
  assert.equal(await window.locator('#inspector-panel').isVisible(), true);

  await window.setViewportSize({ width: 924, height: 601 });
  const minimumFit = await layoutSnapshot(window);
  assert.equal(minimumFit.canScrollX, false);
  assert.equal(minimumFit.canScrollY, false);
  assert.equal(minimumFit.regions.every((region) => region.visible && region.inViewport), true);
  await window.screenshot({ path: path.join(qaDirectory, 'desktop-minimum.png') });

  for (const viewport of [{ width: 760, height: 900 }, { width: 430, height: 932 }]) {
    await window.setViewportSize(viewport);
    await window.locator('#sessions-view-button').click();
    const compactFit = await compactSessionsSnapshot(window);
    assert.equal(compactFit.canScrollX, false);
    assert.equal(compactFit.regions.every((region) => region.visible && region.inViewport), true);
    await window.screenshot({
      path: path.join(qaDirectory, `desktop-sessions-${viewport.width}.png`),
    });
  }
} finally {
  await browser?.close().catch(() => undefined);
  await stopDesktop(desktop);
  await rm(userDataDirectory, { recursive: true, force: true });
}
process.stdout.write(`Smoke de escritorio correcto: ${process.platform}/${process.arch}\n`);

async function resolveExecutablePath(args, fallback) {
  if (args.length === 0) return validateExecutable(fallback, false);
  if (args.length !== 2 || args[0] !== '--executable' || typeof args[1] !== 'string' || args[1].length === 0) {
    throw new Error('Uso: smoke-desktop-package.mjs [--executable <ruta-absoluta>].');
  }
  return validateExecutable(args[1], true);
}

async function validateExecutable(candidate, explicit) {
  if (!path.isAbsolute(candidate)) throw new Error('La ruta del ejecutable Desktop debe ser absoluta.');
  const info = await lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('El ejecutable Desktop debe ser un archivo regular, no un enlace.');
  const expectedName = process.platform === 'win32' ? `${executableName}.exe` : executableName;
  const actualName = path.basename(candidate);
  const matches = process.platform === 'win32'
    ? actualName.toLowerCase() === expectedName.toLowerCase()
    : actualName === expectedName;
  if (!matches) throw new Error(`Ejecutable Desktop inesperado: ${actualName}. Se esperaba ${expectedName}.`);
  const resolved = await realpath(candidate);
  if (explicit) process.stdout.write(`Smoke sobre ejecutable explícito: ${resolved}\n`);
  return resolved;
}

async function layoutSnapshot(window) {
  return window.evaluate(() => {
    const selectors = ['.sidebar', '.workspace', '.inspector'];
    return {
      innerWidth,
      innerHeight,
      canScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      canScrollY: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      regions: selectors.map((selector) => {
        const element = document.querySelector(selector);
        const rect = element?.getBoundingClientRect();
        return {
          selector,
          visible: Boolean(rect && rect.width > 0 && rect.height > 0),
          inViewport: Boolean(rect && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1),
        };
      }),
    };
  });
}

async function compactSessionsSnapshot(window) {
  return window.evaluate(() => {
    const selectors = ['.sidebar', '.sidebar-browser', '.sidebar-tabs', '#sessions-view'];
    return {
      canScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      regions: selectors.map((selector) => {
        const element = document.querySelector(selector);
        const rect = element?.getBoundingClientRect();
        return {
          selector,
          visible: Boolean(rect && rect.width > 0 && rect.height > 0),
          inViewport: Boolean(rect && rect.left >= 0 && rect.top >= 0
            && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1),
        };
      }),
    };
  });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function connectToDesktop(port, child, readStderr) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Electron termino prematuramente: ${readStderr()}`);
    }
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`No se pudo conectar al paquete Electron: ${lastError instanceof Error ? lastError.message : String(lastError)}\n${readStderr()}`);
}

async function findAppWindow(browser) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const window = browser.contexts().flatMap((context) => context.pages())
      .find((page) => page.url() === 'opencode-infinite://app/index.html');
    if (window) return window;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('La ventana empaquetada no cargo el protocolo local.');
}

async function stopDesktop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') child.kill();
  else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  if (exited) return;
  if (process.platform === 'win32') child.kill('SIGKILL');
  else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}
