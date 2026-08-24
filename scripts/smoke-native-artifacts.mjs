import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { packagerConfig } = require('../forge.config.cjs');
const { executableName, name: packageName } = packagerConfig;
const artifactRoot = await resolveArtifactRoot(process.argv.slice(2));
const temporaryRoot = await realpath(os.tmpdir());
const stagingRoot = await mkdtemp(path.join(temporaryRoot, 'opencode-infinite-native-'));
const rootOwnedFiles = new Set();

try {
  if (process.platform === 'darwin') await smokeMacArchive();
  else if (process.platform === 'linux') await smokeLinuxPackages();
  else throw new Error('El smoke de artefactos extraidos solo admite macOS y Linux.');
} finally {
  await restoreRootOwnedFiles();
  await removeStagingRoot();
}

async function smokeMacArchive() {
  const archives = (await walkRegularFiles(artifactRoot)).filter((file) => file.endsWith('.zip'));
  const archive = expectOne(archives, 'archivo ZIP de macOS');
  const destination = path.join(stagingRoot, 'macos');
  await mkdir(destination);
  await run('ditto', ['-x', '-k', archive, destination]);
  const executable = expectOne(
    (await walkRegularFiles(destination)).filter((file) => file.endsWith(path.join(`${packageName}.app`, 'Contents', 'MacOS', executableName))),
    `ejecutable ${packageName}.app`,
  );
  await smokeExecutable(executable);
}

async function smokeLinuxPackages() {
  const artifacts = await walkRegularFiles(artifactRoot);
  const packages = [
    { format: 'deb', artifact: expectOne(artifacts.filter((file) => file.endsWith('.deb')), 'paquete DEB') },
    { format: 'rpm', artifact: expectOne(artifacts.filter((file) => file.endsWith('.rpm')), 'paquete RPM') },
  ];

  for (const { format, artifact } of packages) {
    const destination = path.join(stagingRoot, format);
    await mkdir(destination);
    if (format === 'deb') await run('dpkg-deb', ['--extract', artifact, destination]);
    else await extractRpm(artifact, destination);

    const files = await walkRegularFiles(destination);
    const executable = expectOne(files.filter((file) => path.basename(file) === executableName), `ejecutable del paquete ${format.toUpperCase()}`);
    const sandbox = expectOne(files.filter((file) => path.basename(file) === 'chrome-sandbox'), `chrome-sandbox del paquete ${format.toUpperCase()}`);
    await configureLinuxSandbox(sandbox);
    await smokeExecutable(executable);
  }
}

async function resolveArtifactRoot(args) {
  if (args.length !== 2 || args[0] !== '--artifacts-root' || typeof args[1] !== 'string' || args[1].length === 0) {
    throw new Error('Uso: smoke-native-artifacts.mjs --artifacts-root <ruta-absoluta>.');
  }
  if (!path.isAbsolute(args[1])) throw new Error('La raiz de artefactos debe ser absoluta.');
  const info = await lstat(args[1]);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('La raiz de artefactos debe ser un directorio real.');
  return realpath(args[1]);
}

async function walkRegularFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkRegularFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

function expectOne(files, label) {
  if (files.length !== 1) throw new Error(`Se esperaba exactamente un ${label}; encontrados: ${files.length}.`);
  return files[0];
}

async function extractRpm(artifact, destination) {
  const converter = spawn('rpm2cpio', [artifact], { stdio: ['ignore', 'pipe', 'inherit'] });
  const extractor = spawn('cpio', ['--extract', '--make-directories', '--quiet', '--no-absolute-filenames'], {
    cwd: destination,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  converter.stdout.pipe(extractor.stdin);
  const [converterCode, extractorCode] = await Promise.all([waitForExit(converter), waitForExit(extractor)]);
  if (converterCode !== 0 || extractorCode !== 0) {
    throw new Error(`No se pudo extraer el RPM (rpm2cpio=${converterCode}, cpio=${extractorCode}).`);
  }
}

async function configureLinuxSandbox(candidate) {
  const sandbox = await assertInsideStaging(candidate);
  rootOwnedFiles.add(sandbox);
  await run('sudo', ['chown', 'root:root', '--', sandbox]);
  await run('sudo', ['chmod', '4755', '--', sandbox]);
}

async function smokeExecutable(candidate) {
  const executable = await assertInsideStaging(candidate);
  await run(process.execPath, [path.join(root, 'scripts', 'smoke-desktop-package.mjs'), '--executable', executable]);
}

async function assertInsideStaging(candidate) {
  const resolved = await realpath(candidate);
  const relative = path.relative(stagingRoot, resolved);
  if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Ruta fuera del directorio temporal: ${resolved}`);
  }
  return resolved;
}

async function restoreRootOwnedFiles() {
  if (process.platform !== 'linux' || rootOwnedFiles.size === 0) return;
  const owner = `${process.getuid()}:${process.getgid()}`;
  for (const file of rootOwnedFiles) {
    await run('sudo', ['chown', owner, '--', file]);
    await run('chmod', ['0755', '--', file]);
  }
}

async function removeStagingRoot() {
  const resolved = await realpath(stagingRoot);
  const relative = path.relative(temporaryRoot, resolved);
  if (!path.basename(resolved).startsWith('opencode-infinite-native-') || relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Limpieza temporal rechazada: ${resolved}`);
  }
  await rm(resolved, { recursive: true, force: true });
}

async function run(command, args) {
  const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });
  const code = await waitForExit(child);
  if (code !== 0) throw new Error(`${command} termino con codigo ${code}.`);
}

async function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Proceso terminado por senal ${signal}.`));
      else resolve(code ?? 1);
    });
  });
}
