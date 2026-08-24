import { rm } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { packager } from '@electron/packager';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const forgeConfig = require('../forge.config.cjs');
const electronVersion = require('electron/package.json').version;
const outRoot = path.join(root, 'out');
const makeRoot = path.join(outRoot, 'make');
if (path.dirname(makeRoot) !== outRoot || path.basename(makeRoot) !== 'make') {
  throw new Error(`Directorio de makers inesperado: ${makeRoot}`);
}
await rm(makeRoot, { recursive: true, force: true });
const outputPaths = await packager({
  ...forgeConfig.packagerConfig,
  dir: root,
  out: outRoot,
  overwrite: true,
  platform: process.platform,
  arch: process.arch,
  electronVersion,
});
if (outputPaths.length !== 1) throw new Error(`Se esperaba un paquete; recibidos: ${outputPaths.length}.`);
process.stdout.write(`Paquete creado: ${outputPaths[0]}\n`);
