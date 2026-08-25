import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { RunAttachment } from './contracts.js';

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  '', '.c', '.cc', '.conf', '.cpp', '.cs', '.css', '.csv', '.diff', '.env', '.go', '.h', '.hpp', '.htm',
  '.html', '.ini', '.java', '.js', '.json', '.jsx', '.kt', '.log', '.md', '.mjs', '.patch', '.php', '.ps1',
  '.py', '.rb', '.rs', '.scss', '.sh', '.sql', '.svg', '.swift', '.toml', '.ts', '.tsx', '.txt', '.xml',
  '.yaml', '.yml',
]);

export function attachmentMime(candidate: string): string {
  switch (path.extname(candidate).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.pdf': return 'application/pdf';
    default:
      if (TEXT_EXTENSIONS.has(path.extname(candidate).toLowerCase())) return 'text/plain';
      throw new TypeError(`Tipo de adjunto no compatible: ${path.basename(candidate)}`);
  }
}

export function parseDroppedPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100
    || value.some((candidate) => typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 32_767)) {
    throw new TypeError('Las rutas de los adjuntos no son válidas.');
  }
  return value as string[];
}

export async function inspectAttachments(
  candidates: string[],
  platform = process.platform,
): Promise<RunAttachment[]> {
  if (candidates.length > 100) throw new TypeError('Se admiten hasta 100 archivos adjuntos.');
  const attachments: RunAttachment[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) throw new TypeError('El adjunto debe ser una ruta absoluta.');
    let resolved: string;
    try {
      resolved = await realpath(candidate);
    } catch {
      throw new TypeError(`El adjunto no existe: ${path.basename(candidate) || candidate}`);
    }
    const key = platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    const handle = await open(resolved, 'r').catch(() => {
      throw new TypeError(`No se puede leer el adjunto: ${path.basename(resolved)}`);
    });
    let size: number;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new TypeError(`El adjunto debe ser un archivo: ${path.basename(resolved)}`);
      size = info.size;
    } finally {
      await handle.close();
    }
    if (size > MAX_ATTACHMENT_BYTES) {
      throw new TypeError(`El adjunto supera 20 MiB: ${path.basename(resolved)}`);
    }
    total += size;
    if (total > MAX_ATTACHMENT_BYTES) throw new TypeError('Los adjuntos superan 20 MiB en total.');
    seen.add(key);
    attachments.push({
      path: resolved,
      name: path.basename(resolved),
      mime: attachmentMime(resolved),
      size,
    });
  }
  return attachments;
}

export async function assertAttachmentMetadata(expected: RunAttachment[]): Promise<void> {
  const actual = await inspectAttachments(expected.map((attachment) => attachment.path));
  if (actual.length !== expected.length || actual.some((attachment, index) => {
    const selected = expected[index];
    return !selected || attachment.path !== selected.path || attachment.name !== selected.name
      || attachment.mime !== selected.mime || attachment.size !== selected.size;
  })) {
    throw new TypeError('Los metadatos de los adjuntos cambiaron. Vuelve a seleccionarlos.');
  }
}
