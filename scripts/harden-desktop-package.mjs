import { access, chmod, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { listPackage } from '@electron/asar';
import { flipFuses, FuseV1Options, FuseVersion, getCurrentFuseWire } from '@electron/fuses';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { packagerConfig } = require('../forge.config.cjs');
const { executableName, name: packageName } = packagerConfig;
if (!/^[A-Za-z0-9._-]+$/u.test(packageName) || !/^[A-Za-z0-9._-]+$/u.test(executableName)) {
  throw new Error('Los nombres tecnicos deben ser segmentos de ruta seguros.');
}
const packageRoot = path.join(root, 'out', `${packageName}-${process.platform}-${process.arch}`);
const appBundle = `${packageName}.app`;
const resourcesRoot = process.platform === 'darwin'
  ? path.join(packageRoot, appBundle, 'Contents', 'Resources')
  : path.join(packageRoot, 'resources');
const executable = process.platform === 'darwin'
  ? path.join(packageRoot, appBundle, 'Contents', 'MacOS', executableName)
  : path.join(packageRoot, process.platform === 'win32' ? `${executableName}.exe` : executableName);
await access(executable);
if (process.platform === 'linux') {
  const sandbox = path.join(packageRoot, 'chrome-sandbox');
  await chmod(sandbox, 0o4755);
  if (((await stat(sandbox)).mode & 0o7777) !== 0o4755) throw new Error('chrome-sandbox no conserva el modo 4755.');
}

const archiveEntries = new Set(listPackage(path.join(resourcesRoot, 'app.asar')).map((entry) => entry.replaceAll('\\', '/')));
const allowedRoots = new Set(['assets', 'dist', 'node_modules', 'package.json', 'README.md', 'SECURITY.md', 'LICENSE']);
const allowedModules = new Set(['debug', 'electron-squirrel-startup', 'ms']);
for (const entry of archiveEntries) {
  const segments = entry.split('/').filter(Boolean);
  const archiveRoot = segments[0];
  if (!archiveRoot || !allowedRoots.has(archiveRoot)) throw new Error(`Entrada inesperada en app.asar: ${entry}.`);
  if (archiveRoot === 'node_modules' && segments[1] && !allowedModules.has(segments[1])) {
    throw new Error(`Dependencia inesperada en app.asar: ${entry}.`);
  }
  if (archiveRoot === 'assets' && !['/assets', '/assets/icon.png'].includes(entry)) {
    throw new Error(`Asset inesperado en app.asar: ${entry}.`);
  }
  if (allowedRoots.has(archiveRoot) && !['assets', 'dist', 'node_modules'].includes(archiveRoot) && segments.length !== 1) {
    throw new Error(`Ruta inesperada en app.asar: ${entry}.`);
  }
}
for (const required of [
  '/dist/desktop/main.js',
  '/dist/desktop/preload.cjs',
  '/dist/desktop/contracts.js',
  '/dist/desktop/run-manager.js',
  '/dist/desktop/renderer/app.js',
  '/dist/desktop/renderer/index.html',
  '/dist/desktop/renderer/app.css',
  '/assets/icon.png',
  '/dist/loop.js',
  '/dist/server.js',
]) {
  if (!archiveEntries.has(required)) throw new Error(`Falta ${required} dentro de app.asar.`);
}

const expected = {
  version: FuseVersion.V1,
  strictlyRequireAllFuses: true,
  resetAdHocDarwinSignature: process.platform === 'darwin' && process.arch === 'arm64',
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  [FuseV1Options.WasmTrapHandlers]: false,
};
await flipFuses(executable, expected);
const current = await getCurrentFuseWire(executable);
for (const [key, value] of Object.entries(expected)) {
  const expectedState = value ? 49 : 48;
  if (/^\d+$/.test(key) && current[key] !== expectedState) throw new Error(`El fuse ${key} no quedo aplicado.`);
}
process.stdout.write(`Fuses verificados: ${executable}\n`);
