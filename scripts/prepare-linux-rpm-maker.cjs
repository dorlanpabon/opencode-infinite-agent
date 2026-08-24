const { readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');

const APP_DIRECTORY = '/usr/lib/<%= name %>/';
const SANDBOX_ENTRY = '%attr(4755, root, root) /usr/lib/<%= name %>/chrome-sandbox';

function hardenRpmSpec(source) {
  if (source.includes(SANDBOX_ENTRY)) return source;
  const matches = source.split(APP_DIRECTORY).length - 1;
  if (matches !== 1) throw new Error(`Plantilla RPM inesperada: ${matches} entradas de aplicación.`);
  return source.replace(APP_DIRECTORY, `${APP_DIRECTORY}\n${SANDBOX_ENTRY}`);
}

async function prepareLinuxRpmMaker() {
  if (process.platform !== 'linux') return;
  const packageRoot = path.dirname(require.resolve('electron-installer-redhat/package.json'));
  const specPath = path.join(packageRoot, 'resources', 'spec.ejs');
  const source = await readFile(specPath, 'utf8');
  const hardened = hardenRpmSpec(source);
  if (hardened !== source) await writeFile(specPath, hardened, 'utf8');
}

module.exports = { hardenRpmSpec, prepareLinuxRpmMaker };
