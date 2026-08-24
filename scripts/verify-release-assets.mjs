import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const tag = process.argv[2] ?? process.env.RELEASE_TAG;
if (tag !== `v${packageJson.version}` || !/^v\d+\.\d+\.\d+$/u.test(tag)) throw new Error(`Tag de release invalido: ${String(tag)}.`);
const releaseRoot = path.join(root, 'release-assets');
const expected = [
  `OpenCode-Infinite-${packageJson.version}-windows-x64-Setup.exe`,
  `OpenCode-Infinite-${packageJson.version}-macos-arm64.zip`,
  `OpenCode-Infinite-${packageJson.version}-macos-x64.zip`,
  `OpenCode-Infinite-${packageJson.version}-linux-x64.deb`,
  `OpenCode-Infinite-${packageJson.version}-linux-x64.rpm`,
  `OpenCode-Infinite-${packageJson.version}-linux-arm64.deb`,
  `OpenCode-Infinite-${packageJson.version}-linux-arm64.rpm`,
].sort();
const actual = (await readdir(releaseRoot, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Set incompleto. Esperado=${expected.join(', ')} Actual=${actual.join(', ')}`);
const checksums = [];
for (const name of expected) {
  const file = path.join(releaseRoot, name);
  if ((await stat(file)).size < 1024) throw new Error(`Artefacto truncado: ${name}.`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  checksums.push(`${hash.digest('hex')}  ${name}`);
}
await writeFile(path.join(releaseRoot, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`, 'utf8');
process.stdout.write(`Release ${tag} verificado con ${expected.length} artefactos.\n`);
