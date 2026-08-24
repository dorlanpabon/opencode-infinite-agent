import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'src', 'desktop', 'renderer');
const destination = path.join(root, 'dist', 'desktop', 'renderer');
await mkdir(destination, { recursive: true });
await Promise.all([
  copyFile(path.join(source, 'index.html'), path.join(destination, 'index.html')),
  copyFile(path.join(source, 'app.css'), path.join(destination, 'app.css')),
]);
