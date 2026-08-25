import type { OpenCodeModelCatalog, OpenCodeModelSummary } from './contracts.js';

interface ServerModule {
  request(base: string, method: string, pathname: string, body: unknown, options: Record<string, unknown>): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeId(value: unknown, maximum = 512): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximum && !/[\r\n\0]/u.test(normalized)
    ? normalized
    : null;
}

function providerArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  const source = Array.isArray(value.all)
    ? value.all
    : Array.isArray(value.providers) ? value.providers : [];
  return source.filter(isRecord);
}

function modelEntries(value: unknown): Array<[string, Record<string, unknown>]> {
  if (Array.isArray(value)) {
    return value.flatMap((model, index) => {
      if (!isRecord(model)) return [];
      const id = safeId(model.id) ?? String(index);
      return [[id, model]];
    });
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, model]) => isRecord(model) ? [[key, model]] : []);
}

function defaultMap(value: unknown): Record<string, string> {
  if (!isRecord(value) || !isRecord(value.default)) return {};
  return Object.fromEntries(Object.entries(value.default).flatMap(([providerId, modelId]) => {
    const normalized = safeId(modelId);
    return normalized ? [[providerId, normalized]] : [];
  }));
}

export function normalizeOpenCodeModelCatalog(providerValue: unknown, configValue: unknown): OpenCodeModelCatalog {
  const providers = providerArray(providerValue);
  const defaults = defaultMap(providerValue);
  const connected = isRecord(providerValue) && Array.isArray(providerValue.connected)
    ? new Set(providerValue.connected.flatMap((id) => {
      const normalized = safeId(id, 256);
      return normalized ? [normalized] : [];
    }))
    : null;
  const models: OpenCodeModelSummary[] = [];
  const seen = new Set<string>();

  for (const provider of providers) {
    const providerId = safeId(provider.id, 256);
    if (!providerId || (connected && !connected.has(providerId))) continue;
    const providerName = safeId(provider.name, 512) ?? providerId;
    for (const [key, model] of modelEntries(provider.models)) {
      if (model.status === 'deprecated') continue;
      const modelId = safeId(model.id) ?? safeId(key);
      if (!modelId) continue;
      const id = `${providerId}/${modelId}`;
      if (id.length > 512 || seen.has(id)) continue;
      seen.add(id);
      models.push({
        id,
        providerId,
        providerName,
        modelId,
        name: safeId(model.name, 512) ?? modelId,
        providerDefault: defaults[providerId] === modelId,
      });
    }
  }

  models.sort((left, right) => left.providerName.localeCompare(right.providerName)
    || left.name.localeCompare(right.name)
    || left.id.localeCompare(right.id));
  const configuredCandidate = isRecord(configValue) ? safeId(configValue.model) : null;
  const configuredModel = configuredCandidate?.includes('/') ? configuredCandidate : null;
  return { models, configuredModel };
}

export function parseOpenCodeModelCatalog(value: unknown): OpenCodeModelCatalog {
  if (!isRecord(value) || !Array.isArray(value.models)
    || (value.configuredModel !== null && typeof value.configuredModel !== 'string')) {
    throw new TypeError('OpenCode devolvió un catálogo de modelos inválido.');
  }
  const models = value.models.map((model) => {
    if (!isRecord(model)
      || typeof model.id !== 'string' || typeof model.providerId !== 'string'
      || typeof model.providerName !== 'string' || typeof model.modelId !== 'string'
      || typeof model.name !== 'string' || typeof model.providerDefault !== 'boolean'
      || model.id !== `${model.providerId}/${model.modelId}`
      || [model.id, model.providerId, model.providerName, model.modelId, model.name].some((item) => item.length === 0 || item.length > 512)) {
      throw new TypeError('OpenCode devolvió un catálogo de modelos inválido.');
    }
    return {
      id: model.id,
      providerId: model.providerId,
      providerName: model.providerName,
      modelId: model.modelId,
      name: model.name,
      providerDefault: model.providerDefault,
    };
  });
  return {
    models,
    configuredModel: value.configuredModel === null ? null : safeId(value.configuredModel),
  };
}

export async function loadOpenCodeModelCatalog(
  server: ServerModule,
  base: string,
  directory: string,
  signal?: AbortSignal,
): Promise<OpenCodeModelCatalog> {
  const options = { directory, timeoutMs: 15_000, ...(signal ? { signal } : {}) };
  let providers: unknown;
  try {
    providers = await server.request(base, 'GET', '/provider', null, options);
  } catch (error) {
    const status = isRecord(error) ? Number(error.status) : NaN;
    if (status !== 404 && status !== 405) throw error;
    providers = await server.request(base, 'GET', '/config/providers', null, options);
  }
  const config = await server.request(base, 'GET', '/config', null, options);
  return normalizeOpenCodeModelCatalog(providers, config);
}
