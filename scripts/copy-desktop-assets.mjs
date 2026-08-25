import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = path.join(root, 'src', 'desktop', 'renderer');
const destination = path.join(root, 'dist', 'desktop', 'renderer');
const pluginSource = path.join(root, 'src', 'desktop', 'plugin');
const pluginDestination = path.join(root, 'dist', 'desktop', 'plugin');
await mkdir(destination, { recursive: true });
await mkdir(pluginDestination, { recursive: true });
await Promise.all([
  copyFile(path.join(source, 'index.html'), path.join(destination, 'index.html')),
  copyFile(path.join(source, 'app.css'), path.join(destination, 'app.css')),
  copyFile(
    path.join(pluginSource, 'opencode-infinite-bridge.mjs'),
    path.join(pluginDestination, 'opencode-infinite-bridge.js'),
  ),
]);
