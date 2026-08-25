import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const electron = require('electron');
const input = parseArguments(process.argv.slice(2));
const sessionId = /ses_[A-Za-z0-9]+/u.exec(input.session)?.[0];
assert.ok(sessionId, 'El enlace debe contener un Session ID ses_…');

const userDataDirectory = await mkdtemp(path.join(os.tmpdir(), 'opencode-infinite-real-qa-'));
const port = await reservePort();
const executable = input.executable ?? electron;
const desktop = spawn(executable, [
  ...(input.executable ? [] : ['.']),
  '--remote-debugging-address=127.0.0.1',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDirectory}`,
], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
let stderr = '';
desktop.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-8192); });
let browser;
try {
  browser = await connect(port, desktop, () => stderr);
  const window = await findWindow(browser);
  await window.waitForLoadState('domcontentloaded');
  await window.locator('#sessions-connect-button').click();
  await window.locator('#workspace-input').fill(input.workspace);
  await window.locator('#session-input').fill(input.session);
  await window.locator('#run-submit-button').click();

  const toggle = window.locator(`input[data-session-id="${sessionId}"]`);
  await toggle.waitFor({ state: 'attached', timeout: 30_000 });
  assert.equal(await toggle.isDisabled(), false);
  await window.locator(`input[data-session-id="${sessionId}"] + .session-switch-track`).click();
  assert.equal(await window.locator('#run-dialog').evaluate((dialog) => dialog.open), true);
  assert.equal(await window.locator('#dialog-title').innerText(), 'Coloca el objetivo para activar');
  assert.equal(await window.locator('#session-input').inputValue(), sessionId);
  assert.equal(await window.locator('#task-input').inputValue(), '');
  assert.match((await window.locator('#workspace-input').inputValue()).replaceAll('\\', '/'), /\/moodle_typescript$/u);
  assert.equal(await window.locator('#auto-approve-input').isDisabled(), true);
  assert.match(await window.locator('#auto-approve-detail').innerText(), /directamente en OpenCode Desktop/iu);
  assert.equal(await window.locator('#task-input').evaluate((element) => element === document.activeElement), true);

  const fit = await window.evaluate(() => ({
    canScrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    dialog: (() => {
      const rect = document.querySelector('#run-dialog')?.getBoundingClientRect();
      return Boolean(rect && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight);
    })(),
  }));
  assert.deepEqual(fit, { canScrollX: false, dialog: true });
  const outputDirectory = path.join(root, 'out', 'qa');
  await mkdir(outputDirectory, { recursive: true });
  const screenshot = path.join(outputDirectory, `desktop-session-${sessionId}.png`);
  await window.screenshot({ path: screenshot });
  process.stdout.write(`${JSON.stringify({ sessionId, screenshot, workspace: await window.locator('#workspace-input').inputValue() })}\n`);
} finally {
  await browser?.close().catch(() => undefined);
  await stop(desktop);
  await rm(userDataDirectory, { recursive: true, force: true, maxRetries: process.platform === 'win32' ? 20 : 0, retryDelay: 250 });
}

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('Uso: --session <oc://…> --workspace <ruta-absoluta> [--executable <ruta-absoluta>]');
    values.set(key.slice(2), value);
  }
  const session = values.get('session');
  const workspace = values.get('workspace');
  const executable = values.get('executable') ?? null;
  if (!session || !workspace || !path.isAbsolute(workspace) || (executable !== null && !path.isAbsolute(executable))) {
    throw new Error('Uso: --session <oc://…> --workspace <ruta-absoluta> [--executable <ruta-absoluta>]');
  }
  return { executable, session, workspace };
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

async function connect(port, child, readStderr) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Electron terminó: ${readStderr()}`);
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1_000 });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`No se pudo conectar a Electron: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function findWindow(browser) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const window = browser.contexts().flatMap((context) => context.pages())
      .find((page) => page.url() === 'opencode-infinite://app/index.html');
    if (window) return window;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('La ventana OpenCode Infinite no cargó.');
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
}
