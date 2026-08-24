const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('renderer y ventana Desktop conservan aislamiento estricto', async () => {
  const [main, preload, renderer, html] = await Promise.all([
    readFile(path.join(root, 'dist', 'desktop', 'main.js'), 'utf8'),
    readFile(path.join(root, 'dist', 'desktop', 'preload.cjs'), 'utf8'),
    readFile(path.join(root, 'dist', 'desktop', 'renderer', 'app.js'), 'utf8'),
    readFile(path.join(root, 'dist', 'desktop', 'renderer', 'index.html'), 'utf8'),
  ]);
  assert.match(main, /contextIsolation:\s*true/u);
  assert.match(main, /nodeIntegration:\s*false/u);
  assert.match(main, /sandbox:\s*true/u);
  assert.match(main, /setPermissionRequestHandler/u);
  assert.match(preload, /contextBridge\.exposeInMainWorld/u);
  assert.doesNotMatch(renderer, /\.innerHTML\b|\beval\s*\(|setInterval\s*\(/u);
  assert.match(html, /Content-Security-Policy/u);
  assert.match(html, /id="auto-approve-input"[^>]*>/u);
  assert.doesNotMatch(html.match(/id="auto-approve-input"[^>]*>/u)?.[0] ?? '', /\bchecked\b/u);
});

test('paquete Electron usa allowlist y makers multiplataforma', () => {
  const { makers, packagerConfig } = require('../forge.config.cjs');
  const ignored = (candidate) => packagerConfig.ignore.some((pattern) => pattern.test(candidate));
  assert.equal(packagerConfig.name, packagerConfig.executableName);
  assert.match(packagerConfig.icon, /assets[\\/]icon$/u);
  assert.equal(ignored('/dist/desktop/main.js'), false);
  assert.equal(ignored('/assets/icon.png'), false);
  assert.equal(ignored('/assets/icon.svg'), true);
  assert.equal(ignored('/src/server.js'), true);
  assert.equal(ignored('/.task-tiktok.txt'), true);
  assert.equal(ignored('/node_modules/@electron-forge/cli/package.json'), true);
  assert.ok(makers.some((maker) => maker.platforms?.includes('win32')));
  assert.ok(makers.some((maker) => maker.platforms?.includes('darwin')));
  assert.equal(makers.filter((maker) => maker.platforms?.includes('linux')).length, 2);
});
