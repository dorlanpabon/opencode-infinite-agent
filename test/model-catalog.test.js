const assert = require('node:assert/strict');
const test = require('node:test');
const {
  loadOpenCodeModelCatalog,
  normalizeOpenCodeModelCatalog,
  parseOpenCodeModelCatalog,
} = require('../dist/desktop/model-catalog.js');

function liveFixture() {
  const counts = { zai: 15, opencode: 62, 'kimi-for-coding': 4, moonshotai: 10, openai: 7 };
  const providers = Object.entries(counts).map(([id, count]) => ({
    id,
    name: id === 'openai' ? 'OpenAI' : id,
    models: Object.fromEntries(Array.from({ length: count }, (_, index) => {
      const modelId = `${id}-model-${index + 1}`;
      return [modelId, { id: modelId, name: `Modelo ${index + 1}` }];
    })),
  }));
  return {
    all: providers,
    connected: providers.map((provider) => provider.id),
    default: Object.fromEntries(providers.map((provider) => [provider.id, Object.keys(provider.models)[0]])),
  };
}

test('normaliza los 98 modelos vivos, todos los proveedores y sus defaults sin inventar uno global', () => {
  const catalog = normalizeOpenCodeModelCatalog(liveFixture(), { model: null });
  assert.equal(catalog.models.length, 98);
  assert.equal(new Set(catalog.models.map((model) => model.providerId)).size, 5);
  assert.equal(catalog.models.filter((model) => model.providerDefault).length, 5);
  assert.equal(catalog.configuredModel, null);
  assert.equal(catalog.models.some((model) => model.id === 'openai/openai-model-7'), true);
  assert.deepEqual(parseOpenCodeModelCatalog(catalog), catalog);
});

test('conserva el default global configurado aunque el renderer decida si está disponible', () => {
  const catalog = normalizeOpenCodeModelCatalog(liveFixture(), { model: 'openai/openai-model-7' });
  assert.equal(catalog.configuredModel, 'openai/openai-model-7');
});

test('carga el catálogo por API y usa /config/providers solo si /provider no existe', async () => {
  const calls = [];
  const fixture = liveFixture();
  const server = {
    async request(_base, method, pathname, _body, options) {
      calls.push({ method, pathname, options });
      if (pathname === '/provider') {
        const error = new Error('not found');
        error.status = 404;
        throw error;
      }
      if (pathname === '/config/providers') return { providers: fixture.all, default: fixture.default };
      if (pathname === '/config') return { model: null, provider: { secret: { options: { apiKey: 'never-expose' } } } };
      throw new Error(`unexpected ${pathname}`);
    },
  };
  const catalog = await loadOpenCodeModelCatalog(server, 'http://127.0.0.1:4096', 'C:\\workspace');
  assert.equal(catalog.models.length, 98);
  assert.equal(JSON.stringify(catalog).includes('never-expose'), false);
  assert.deepEqual(calls.map((call) => call.pathname), ['/provider', '/config/providers', '/config']);
  assert.equal(calls.every((call) => call.method === 'GET' && call.options.directory === 'C:\\workspace'), true);
});
