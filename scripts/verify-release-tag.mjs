import { readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const tag = process.argv[2] ?? process.env.RELEASE_TAG;
const expected = `v${packageJson.version}`;
if (tag !== expected || !/^v\d+\.\d+\.\d+$/u.test(tag)) throw new Error(`El tag ${String(tag)} no coincide con ${expected}.`);
process.stdout.write(`Tag de release verificado: ${tag}\n`);
