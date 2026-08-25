import path from 'node:path';
import { parseSessionId } from './contracts.js';

export const OPENCODE_DESKTOP_SERVER_KEY = 'c2lkZWNhcg';

export function buildOpenCodeProjectUrl(workspace: string): string {
  if (typeof workspace !== 'string' || workspace.length === 0 || workspace.length > 32_767
    || workspace !== workspace.trim() || !path.isAbsolute(workspace)) {
    throw new TypeError('El workspace debe ser una ruta absoluta.');
  }
  const url = new URL('opencode://open-project');
  url.searchParams.set('directory', workspace);
  return url.toString();
}

export function buildOpenCodeInternalSessionLink(sessionId: unknown): string {
  const parsedSessionId = parseSessionId(sessionId);
  return `oc://renderer/server/${OPENCODE_DESKTOP_SERVER_KEY}/session/${parsedSessionId}`;
}
