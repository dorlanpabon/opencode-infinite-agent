const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const {
  buildRunDeepLink,
  buildSessionDeepLink,
  parseDeepLink,
} = require('../dist/desktop/contracts.js');

const root = path.resolve(__dirname, '..');

test('deeplinks hacen roundtrip canónico y rechazan autoridad, acciones y rutas ambiguas', () => {
  const runId = '123e4567-e89b-42d3-a456-426614174000';
  const runLink = buildRunDeepLink(runId);
  const sessionLink = buildSessionDeepLink('ses_Abc123');
  assert.equal(runLink, `opencode-infinite://run/${runId}`);
  assert.equal(sessionLink, 'opencode-infinite://session/ses_Abc123');
  assert.deepEqual(parseDeepLink(runLink), { kind: 'run', id: runId });
  assert.deepEqual(parseDeepLink(sessionLink), { kind: 'session', id: 'ses_Abc123' });
  assert.equal(buildRunDeepLink(runId.toUpperCase()), runLink);

  for (const candidate of [
    ` opencode-infinite://run/${runId}`,
    `opencode-infinite://run/${runId}\n`,
    `opencode-infinite://user:password@run/${runId}`,
    `opencode-infinite://run:4096/${runId}`,
    `opencode-infinite://run/${runId}?resume=true`,
    `opencode-infinite://run/${runId}#start`,
    `opencode-infinite://run/${runId}/resume`,
    `opencode-infinite://run/%2f${runId}`,
    'opencode-infinite://session/ses_Abc123/continue',
    'opencode-infinite://session/ses_Abc123?continuous=true',
    'opencode-infinite://app/index.html',
  ]) {
    assert.equal(parseDeepLink(candidate), null, candidate);
  }
});

test('integración del protocolo cubre cold start, segunda instancia y macOS sin autoacciones', async () => {
  const [main, renderer] = await Promise.all([
    readFile(path.join(root, 'src', 'desktop', 'main.ts'), 'utf8'),
    readFile(path.join(root, 'src', 'desktop', 'renderer', 'app.ts'), 'utf8'),
  ]);
  assert.match(main, /queueDeepLinksFromArgv\(process\.argv\)/u);
  assert.match(main, /app\.on\('second-instance',[\s\S]*queueDeepLinksFromArgv\(argv\)/u);
  assert.match(main, /app\.on\('open-url',[\s\S]*queueDeepLink\(url\)/u);
  assert.match(main, /setAsDefaultProtocolClient\('opencode-infinite'\)/u);
  assert.match(main, /setAsDefaultProtocolClient\('opencode-infinite', process\.execPath/u);
  assert.match(main, /process\.argv\[1\]/u);
  assert.match(main, /--squirrel-install/u);
  assert.match(main, /--squirrel-updated/u);
  assert.match(main, /--squirrel-uninstall/u);
  assert.match(main, /removeAsDefaultProtocolClient\('opencode-infinite'\)/u);
  assert.match(main, /window\.loadURL\(`\$\{DESKTOP_ORIGIN\}\/index\.html`\)/u);

  const selector = renderer.slice(
    renderer.indexOf('function applyDeepLinkTarget'),
    renderer.indexOf('function handleDesktopEvent'),
  );
  assert.match(selector, /selectedRunId = run\.runId/u);
  assert.match(selector, /selectedSessionId = target\.id/u);
  assert.doesNotMatch(selector, /startRun|resumeRun|setContinuous|openRunDialog/u);
});

test('Forge registra protocolo y argumentos URI en todos los paquetes Linux', () => {
  const { makers, packagerConfig } = require('../forge.config.cjs');
  assert.deepEqual(packagerConfig.protocols, [{ name: 'OpenCode Infinite', schemes: ['opencode-infinite'] }]);
  const linuxMakers = makers.filter((maker) => maker.platforms?.includes('linux'));
  assert.equal(linuxMakers.length, 2);
  for (const maker of linuxMakers) {
    assert.deepEqual(maker.config.options.mimeType, ['x-scheme-handler/opencode-infinite']);
  }
  const rpm = linuxMakers.find((maker) => maker.name === '@electron-forge/maker-rpm');
  assert.deepEqual(rpm?.config.options.execArguments, ['%U']);
});

test('contexto de corridas conserva la conexión original y no cambia el catálogo visible', async () => {
  const [renderer, adapter] = await Promise.all([
    readFile(path.join(root, 'src', 'desktop', 'renderer', 'app.ts'), 'utf8'),
    readFile(path.join(root, 'src', 'desktop', 'engine-adapter.ts'), 'utf8'),
  ]);
  const contextTarget = renderer.slice(renderer.indexOf('function contextTarget'), renderer.indexOf('function renderSessionContext'));
  assert.match(contextTarget, /sessionRef: run\.sessionRef/u);
  assert.doesNotMatch(contextTarget, /sessionRef: sessionId/u);
  const getContext = adapter.slice(adapter.indexOf('async getSessionContext'), adapter.indexOf('async shutdown'));
  assert.match(getContext, /const useDesktop = input\.connectionMode === 'desktop-sidecar'/u);
  assert.doesNotMatch(getContext, /catalogMode\s*=/u);
});
