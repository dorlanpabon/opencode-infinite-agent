// opencode-infinite-agent:desktop-bridge
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_VERSION = 5;
const BRIDGE_BUILD_ID = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
const GLOBAL_SESSION_PAGE_SIZE = 100;
const MAX_GLOBAL_SESSION_PAGES = 50;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const SESSION_ID = /^ses_[A-Za-z0-9]+$/u;
const MAX_CONTEXT_MESSAGES = 20;
const MAX_CONTEXT_MESSAGE_TEXT = 4_000;
const MAX_CONTEXT_TEXT = 24_000;
const REGISTRY_STATE = Symbol.for('opencode-infinite-agent.desktop-bridge.registry');
const registryState = globalThis[REGISTRY_STATE] ??= { cleanupRegistered: false, files: new Set() };
let globalCatalogAvailable;

function trackRegistryFile(file) {
  registryState.files.add(file);
  if (registryState.cleanupRegistered) return;
  registryState.cleanupRegistered = true;
  process.once('exit', () => {
    for (const target of registryState.files) rmSync(target, { force: true });
    registryState.files.clear();
  });
}

function writeSse(target, payload) {
  try {
    if (target.write(payload)) return true;
  } catch {}
  target.destroy();
  return false;
}

function bridgeDirectory() {
  const configured = process.env.OPENCODE_INFINITE_STATE_DIR;
  if (configured && path.isAbsolute(configured)) return path.join(configured, 'bridges');
  return path.join(os.homedir(), '.opencode-infinite', 'bridges');
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function authorized(request, token) {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const candidate = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

async function bodyOf(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('El cuerpo excede el límite seguro del puente.');
      error.status = 413;
      throw error;
    }
    chunks.push(bytes);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    const error = new Error('JSON inválido.');
    error.status = 400;
    throw error;
  }
}

async function sdkData(promise) {
  const result = await promise;
  if (result && result.error !== undefined) {
    const error = new Error(configErrorSummary(result.error) ?? 'OpenCode rechazó la solicitud del puente.');
    error.status = Number(result.response?.status) || 502;
    error.detail = result.error;
    throw error;
  }
  return result?.data;
}

function diagnosticText(value, maximum = 320) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[opusr]_[A-Za-z0-9_-]{8,}|hf_[A-Za-z0-9_-]{8,})\b/giu, '[REDACTED]')
    .replace(/\b(api[-_ ]?key|authorization|password|secret|token)\s*[:=]\s*[^,;\s]+/giu, '$1=[REDACTED]')
    .trim()
    .slice(0, maximum);
}

function configErrorSummary(detail) {
  if (!detail || typeof detail !== 'object' || detail.name !== 'ConfigInvalidError'
    || !detail.data || typeof detail.data !== 'object') return null;
  const configPath = diagnosticText(detail.data.path, 1_024);
  const issues = Array.isArray(detail.data.issues) ? detail.data.issues : [];
  const summaries = issues.slice(0, 5).flatMap((issue) => {
    if (!issue || typeof issue !== 'object') return [];
    const field = Array.isArray(issue.path)
      ? issue.path.map((part) => diagnosticText(String(part), 80)).filter(Boolean).join('.')
      : '';
    const message = diagnosticText(issue.message);
    if (!field && !message) return [];
    return [`${field || 'config'}${message ? `: ${message}` : ''}`];
  });
  const location = configPath ? ` en ${configPath}` : '';
  const problems = summaries.length > 0 ? ` (${summaries.join('; ')})` : '';
  return `Configuración de OpenCode inválida${location}${problems}.`;
}

async function globalSessions(client) {
  const projectSessions = () => sdkData(client.session.list({ query: { roots: true } }));
  if (globalCatalogAvailable === false) return (await projectSessions()) ?? [];
  const transport = client?._client;
  if (!transport || typeof transport.get !== 'function') {
    globalCatalogAvailable = false;
    return (await projectSessions()) ?? [];
  }
  const sessions = [];
  const cursors = new Set();
  let cursor;
  for (let page = 0; page < MAX_GLOBAL_SESSION_PAGES; page += 1) {
    const result = await transport.get({
      url: '/experimental/session',
      query: {
        roots: true,
        limit: GLOBAL_SESSION_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      },
    });
    if (result?.error !== undefined) {
      const status = Number(result.response?.status) || 502;
      if (page === 0 && (status === 404 || status === 405)) {
        globalCatalogAvailable = false;
        return (await projectSessions()) ?? [];
      }
      const error = new Error('OpenCode interrumpió el catálogo global de sesiones.');
      error.status = status;
      throw error;
    }
    globalCatalogAvailable = true;
    if (!Array.isArray(result?.data)) break;
    sessions.push(...result.data);
    const header = result.response?.headers?.get?.('x-next-cursor');
    const next = Number(header);
    if (!header || !Number.isFinite(next) || cursors.has(next)) break;
    cursors.add(next);
    cursor = next;
  }
  return sessions;
}

function catalogText(value, maximum = 512) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximum && !/[\r\n\0]/u.test(normalized)
    ? normalized
    : null;
}

function catalogProviders(value) {
  if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object');
  if (!value || typeof value !== 'object') return [];
  const source = Array.isArray(value.all) ? value.all : Array.isArray(value.providers) ? value.providers : [];
  return source.filter((item) => item && typeof item === 'object');
}

function catalogModelEntries(value) {
  if (Array.isArray(value)) return value.flatMap((model, index) => model && typeof model === 'object' ? [[String(index), model]] : []);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).filter(([, model]) => model && typeof model === 'object');
}

function safeModelCatalog(providerValue, configValue) {
  const defaults = providerValue && typeof providerValue === 'object' && providerValue.default && typeof providerValue.default === 'object'
    ? providerValue.default
    : {};
  const connected = providerValue && typeof providerValue === 'object' && Array.isArray(providerValue.connected)
    ? new Set(providerValue.connected.map((id) => catalogText(id, 256)).filter(Boolean))
    : null;
  const models = [];
  const seen = new Set();
  for (const provider of catalogProviders(providerValue)) {
    const providerId = catalogText(provider.id, 256);
    if (!providerId || (connected && !connected.has(providerId))) continue;
    const providerName = catalogText(provider.name) ?? providerId;
    for (const [key, model] of catalogModelEntries(provider.models)) {
      if (model.status === 'deprecated') continue;
      const modelId = catalogText(model.id) ?? catalogText(key);
      if (!modelId) continue;
      const id = `${providerId}/${modelId}`;
      if (id.length > 512 || seen.has(id)) continue;
      seen.add(id);
      models.push({
        id,
        providerId,
        providerName,
        modelId,
        name: catalogText(model.name) ?? modelId,
        providerDefault: defaults[providerId] === modelId,
      });
    }
  }
  models.sort((left, right) => left.providerName.localeCompare(right.providerName)
    || left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  const configuredCandidate = configValue && typeof configValue === 'object' ? catalogText(configValue.model) : null;
  return {
    models,
    configuredModel: configuredCandidate?.includes('/') ? configuredCandidate : null,
  };
}

async function liveModelCatalog(client, directory) {
  const transport = client?._client;
  if (!transport || typeof transport.get !== 'function') {
    throw new Error('Esta versión de OpenCode Desktop no expone el catálogo vivo de modelos.');
  }
  let providers;
  try {
    providers = await sdkData(transport.get({ url: '/provider', query: { directory } }));
  } catch (error) {
    if (error?.status !== 404 && error?.status !== 405) throw error;
    providers = await sdkData(transport.get({ url: '/config/providers', query: { directory } }));
  }
  const config = await sdkData(transport.get({ url: '/config', query: { directory } }));
  return safeModelCatalog(providers, config);
}

function requestDirectory(url, request, fallback) {
  const query = url.searchParams.get('directory');
  const header = request.headers['x-opencode-directory'];
  for (const candidate of [query, typeof header === 'string' ? decodeURIComponent(header) : null]) {
    if (candidate && path.isAbsolute(candidate)) return candidate;
  }
  return fallback;
}

function sessionRoute(pathname) {
  const match = /^\/session\/(ses_[A-Za-z0-9]+)(?:\/(message|todo|prompt_async|abort))?$/u.exec(pathname);
  if (!match || !SESSION_ID.test(match[1])) return null;
  return { id: match[1], action: match[2] ?? 'get' };
}

function contextLimit(url) {
  const values = url.searchParams.getAll('limit');
  if (values.length === 0) return MAX_CONTEXT_MESSAGES;
  if (values.length !== 1 || !/^(?:[1-9]|1\d|20)$/u.test(values[0])) {
    const error = new Error('El límite de contexto debe ser un entero entre 1 y 20.');
    error.status = 400;
    throw error;
  }
  return Number(values[0]);
}

function safeContextMessages(value, limit) {
  const rawMessages = Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray(value.data) ? value.data : [];
  const selected = [];
  let remaining = MAX_CONTEXT_TEXT;
  for (let index = rawMessages.length - 1; index >= 0; index -= 1) {
    if (selected.length >= limit || remaining <= 0) break;
    const raw = rawMessages[index];
    if (!raw || typeof raw !== 'object') continue;
    const info = raw.info && typeof raw.info === 'object' ? raw.info : raw;
    if (info.synthetic === true || raw.synthetic === true || (info.role !== 'user' && info.role !== 'assistant')) continue;
    const parts = Array.isArray(raw.parts) ? raw.parts : [];
    const chunks = [];
    let messageRemaining = Math.min(MAX_CONTEXT_MESSAGE_TEXT, remaining);
    for (const part of parts) {
      if (!part || typeof part !== 'object' || part.type !== 'text' || part.synthetic === true || typeof part.text !== 'string') continue;
      let start = 0;
      while (start < part.text.length && /\s/u.test(part.text[start])) start += 1;
      const separator = chunks.length === 0 ? 0 : 1;
      const text = part.text.slice(start, start + Math.max(0, messageRemaining - separator)).trimEnd();
      if (!text) continue;
      chunks.push(text);
      messageRemaining -= separator + text.length;
      if (messageRemaining <= 0) break;
    }
    const text = chunks.join('\n');
    if (!text) continue;
    selected.push({ role: info.role, text });
    remaining -= text.length;
  }
  return selected.reverse();
}

export const OpenCodeInfiniteBridge = async ({ client, directory, project, worktree }) => {
  const bridgeId = randomBytes(16).toString('hex');
  const token = randomBytes(32).toString('hex');
  const eventClients = new Set();
  const sockets = new Set();
  let registryFile = null;
  let disposed = false;

  const server = createServer(async (request, response) => {
    try {
      if (!authorized(request, token)) {
        response.setHeader('www-authenticate', 'Bearer');
        json(response, 401, { error: 'No autorizado.' });
        return;
      }

      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const scopedDirectory = requestDirectory(url, request, directory);

      if (request.method === 'GET' && url.pathname === '/global/health') {
        json(response, 200, {
          healthy: true,
          version: `desktop-bridge-${BRIDGE_VERSION}`,
          buildId: BRIDGE_BUILD_ID,
          bridgeId,
          projectID: project.id,
          directory,
          worktree,
          pid: process.pid,
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/event') {
        response.writeHead(200, {
          'cache-control': 'no-cache, no-store',
          connection: 'keep-alive',
          'content-type': 'text/event-stream; charset=utf-8',
          'x-accel-buffering': 'no',
        });
        if (!writeSse(response, `data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`)) return;
        eventClients.add(response);
        const heartbeat = setInterval(() => {
          if (!writeSse(response, ': heartbeat\n\n')) eventClients.delete(response);
        }, 15_000);
        request.once('close', () => {
          clearInterval(heartbeat);
          eventClients.delete(response);
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/session') {
        const data = await globalSessions(client);
        json(response, 200, data ?? []);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/session/status') {
        const data = await sdkData(client.session.status({ query: { directory: scopedDirectory } }));
        json(response, 200, data ?? {});
        return;
      }

      if (request.method === 'GET' && url.pathname === '/models') {
        json(response, 200, await liveModelCatalog(client, scopedDirectory));
        return;
      }

      const route = sessionRoute(url.pathname);
      if (route && request.method === 'GET' && route.action === 'get') {
        const data = await sdkData(client.session.get({
          path: { id: route.id },
          query: { directory: scopedDirectory },
        }));
        json(response, 200, data);
        return;
      }

      if (route && request.method === 'GET' && route.action === 'message') {
        const limit = contextLimit(url);
        const data = await sdkData(client.session.messages({
          path: { id: route.id },
          query: { directory: scopedDirectory, limit },
        }));
        json(response, 200, safeContextMessages(data, limit));
        return;
      }

      if (route && request.method === 'GET' && route.action === 'todo') {
        const data = await sdkData(client.session.todo({
          path: { id: route.id },
          query: { directory: scopedDirectory },
        }));
        json(response, 200, data ?? []);
        return;
      }

      if (route && request.method === 'POST' && route.action === 'prompt_async') {
        const body = await bodyOf(request);
        await sdkData(client.session.promptAsync({
          path: { id: route.id },
          query: { directory: scopedDirectory },
          body,
        }));
        response.writeHead(204, { 'cache-control': 'no-store' });
        response.end();
        return;
      }

      if (route && request.method === 'POST' && route.action === 'abort') {
        const data = await sdkData(client.session.abort({
          path: { id: route.id },
          query: { directory: scopedDirectory },
        }));
        json(response, 200, data ?? true);
        return;
      }

      json(response, 404, { error: 'Ruta no permitida.' });
    } catch (error) {
      const status = Number(error?.status);
      json(response, Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500, {
        error: error instanceof Error ? error.message : 'Error del puente.',
      });
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  server.unref();

  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No se pudo abrir el puente local.');
  const root = bridgeDirectory();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const projectKey = createHash('sha256').update(`${project.id}\0${directory}`).digest('hex').slice(0, 16);
  registryFile = path.join(root, `${process.pid}-${projectKey}-${bridgeId}.json`);
  const temporary = `${registryFile}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temporary, JSON.stringify({
    schemaVersion: 1,
    bridgeVersion: BRIDGE_VERSION,
    buildId: BRIDGE_BUILD_ID,
    bridgeId,
    endpoint: `http://127.0.0.1:${address.port}`,
    token,
    pid: process.pid,
    projectID: project.id,
    directory,
    worktree,
    startedAt: new Date().toISOString(),
  }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  renameSync(temporary, registryFile);
  trackRegistryFile(registryFile);

  return {
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      for (const target of eventClients) target.destroy();
      eventClients.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      if (registryFile) {
        rmSync(registryFile, { force: true });
        registryState.files.delete(registryFile);
        registryFile = null;
      }
      await new Promise((resolve) => server.close(() => resolve()));
    },
    event: async ({ event }) => {
      if (disposed) return;
      const payload = `data: ${JSON.stringify(event)}\n\n`;
      for (const target of [...eventClients]) {
        if (!writeSse(target, payload)) eventClients.delete(target);
      }
    },
  };
};
