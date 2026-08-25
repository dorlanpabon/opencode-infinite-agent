import { copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const tag = process.argv[2] ?? process.env.RELEASE_TAG;
if (tag !== `v${packageJson.version}` || !/^v\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)(?:\.\d+)?)?$/u.test(tag)) {
  throw new Error(`El tag ${String(tag)} no coincide con v${packageJson.version}.`);
}
const makeRoot = path.join(root, 'out', 'make');
const releaseRoot = path.join(root, 'release-assets');
if (path.dirname(releaseRoot) !== root || path.basename(releaseRoot) !== 'release-assets') throw new Error(`Ruta inesperada: ${releaseRoot}`);
await rm(releaseRoot, { recursive: true, force: true });
await mkdir(releaseRoot, { recursive: true });
const files = await walk(makeRoot);
const target = process.platform === 'win32' ? 'windows-x64'
  : process.platform === 'darwin' && process.arch === 'arm64' ? 'macos-arm64'
    : process.platform === 'darwin' && process.arch === 'x64' ? 'macos-x64'
    : process.platform === 'linux' && process.arch === 'x64' ? 'linux-x64'
      : process.platform === 'linux' && process.arch === 'arm64' ? 'linux-arm64' : null;
if (!target) throw new Error(`Plataforma no soportada: ${process.platform}/${process.arch}.`);
const expected = process.platform === 'win32'
  ? [{ extension: '.exe', matches: (file) => /Setup\.exe$/iu.test(file) }]
  : process.platform === 'darwin'
    ? [{ extension: '.zip', matches: (file) => file.toLowerCase().endsWith('.zip') }]
    : [
      { extension: '.deb', matches: (file) => file.toLowerCase().endsWith('.deb') },
      { extension: '.rpm', matches: (file) => file.toLowerCase().endsWith('.rpm') },
    ];
for (const asset of expected) {
  const matches = files.filter(asset.matches);
  if (matches.length !== 1) throw new Error(`Se esperaba un ${asset.extension} para ${target}; encontrados: ${matches.length}.`);
  if (!(await stat(matches[0])).isFile() || (await stat(matches[0])).size < 1024) throw new Error(`Artefacto invalido: ${matches[0]}.`);
  const suffix = process.platform === 'win32' ? '-Setup.exe' : asset.extension;
  const destination = path.join(releaseRoot, `OpenCode-Infinite-${packageJson.version}-${target}${suffix}`);
  await copyFile(matches[0], destination);
  process.stdout.write(`Artefacto preparado: ${destination}\n`);
}

async function walk(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(candidate));
    else if (entry.isFile()) output.push(candidate);
  }
  return output.sort();
}
