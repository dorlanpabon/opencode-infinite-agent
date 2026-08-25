const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { hardenRpmSpec } = require('../scripts/prepare-linux-rpm-maker.cjs');

const root = path.resolve(__dirname, '..');

test('renderer, puente y ventana Desktop conservan aislamiento estricto', async () => {
  const [main, preload, renderer, html, plugin] = await Promise.all([
    readFile(path.join(root, 'dist', 'desktop', 'main.js'), 'utf8'),
    readFile(path.join(root, 'dist', 'desktop', 'preload.cjs'), 'utf8'),
    readFile(path.join(root, 'dist', 'desktop', 'renderer', 'app.js'), 'utf8'),
    readFile(path.join(root, 'dist', 'desktop', 'renderer', 'index.html'), 'utf8'),
    readFile(path.join(root, 'dist', 'desktop', 'plugin', 'opencode-infinite-bridge.js'), 'utf8'),
  ]);
  assert.match(main, /contextIsolation:\s*true/u);
  assert.match(main, /nodeIntegration:\s*false/u);
  assert.match(main, /sandbox:\s*true/u);
  assert.match(main, /setPermissionRequestHandler/u);
  assert.match(preload, /contextBridge\.exposeInMainWorld/u);
  assert.match(preload, /webUtils\.getPathForFile/u);
  assert.doesNotMatch(renderer, /\.innerHTML\b|\beval\s*\(|setInterval\s*\(/u);
  assert.match(html, /Content-Security-Policy/u);
  assert.match(html, /id="auto-approve-input"[^>]*>/u);
  assert.doesNotMatch(html.match(/id="auto-approve-input"[^>]*>/u)?.[0] ?? '', /\bchecked\b/u);
  assert.doesNotMatch(html.match(/id="task-input"[^>]*>/u)?.[0] ?? '', /\bmaxlength=/u);
  assert.match(html, /id="attachments-picker-button"/u);
  assert.match(plugin, /OpenCodeInfiniteBridge/u);
  assert.match(plugin, /127\.0\.0\.1/u);
  assert.match(plugin, /timingSafeEqual/u);
});

test('renderer conserva navegación y foco accesibles en sesiones', async () => {
  const [renderer, css] = await Promise.all([
    readFile(path.join(root, 'dist', 'desktop', 'renderer', 'app.js'), 'utf8'),
    readFile(path.join(root, 'dist', 'desktop', 'renderer', 'app.css'), 'utf8'),
  ]);
  assert.match(renderer, /\(currentIndex \+ direction \+ tabs\.length\) % tabs\.length/u);
  assert.match(renderer, /sessionFocusFallback/u);
  assert.match(renderer, /Hay otra ejecución activa/u);
  assert.match(renderer, /aria-describedby/u);
  assert.match(renderer, /Coloca el objetivo para activar/u);
  assert.match(renderer, /autoApproveInput\.disabled\s*=\s*Boolean\(target\)/u);
  assert.match(renderer, /Confirma los permisos directamente en OpenCode Desktop/u);
  assert.match(renderer, /resolveDroppedAttachments/u);
  assert.match(css, /\.session-item:focus/u);
});

test('paquete Electron usa allowlist y makers multiplataforma', () => {
  const { makers, packagerConfig } = require('../forge.config.cjs');
  const ignored = (candidate) => packagerConfig.ignore.some((pattern) => pattern.test(candidate));
  assert.equal(packagerConfig.name, packagerConfig.executableName);
  assert.match(packagerConfig.icon, /assets[\\/]icon$/u);
  assert.equal(ignored('/dist/desktop/main.js'), false);
  assert.equal(ignored('/dist/desktop/plugin/opencode-infinite-bridge.js'), false);
  assert.equal(ignored('/assets/icon.png'), false);
  assert.equal(ignored('/assets/icon.svg'), true);
  assert.equal(ignored('/src/server.js'), true);
  assert.equal(ignored('/.task-tiktok.txt'), true);
  assert.equal(ignored('/node_modules/@electron-forge/cli/package.json'), true);
  assert.ok(makers.some((maker) => maker.platforms?.includes('win32')));
  assert.ok(makers.some((maker) => maker.platforms?.includes('darwin')));
  assert.equal(makers.filter((maker) => maker.platforms?.includes('linux')).length, 2);
});

test('plantilla RPM fija chrome-sandbox a root y modo 4755', () => {
  const source = '%files\n/usr/lib/<%= name %>/\n';
  const hardened = hardenRpmSpec(source);
  assert.match(hardened, /%attr\(4755, root, root\) \/usr\/lib\/<%= name %>\/chrome-sandbox/u);
  assert.equal(hardenRpmSpec(hardened), hardened);
});

test('smokes nativos rechazan rutas relativas', () => {
  for (const [script, args] of [
    ['smoke-desktop-package.mjs', ['--executable', 'OpenCodeInfinite']],
    ['smoke-native-artifacts.mjs', ['--artifacts-root', 'out/make']],
  ]) {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /debe ser absoluta/u);
  }
});
