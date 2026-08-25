const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { parseSessionContextPayload } = require('../dist/desktop/session-context.js');

const root = path.resolve(__dirname, '..');

test('renderer liga contexto a toda la conexión sin imports fuera de su paquete', async () => {
  const [source, compiled] = await Promise.all([
    readFile(path.join(root, 'src', 'desktop', 'renderer', 'app.ts'), 'utf8'),
    readFile(path.join(root, 'dist', 'desktop', 'renderer', 'app.js'), 'utf8'),
  ]);
  const keyHelper = source.slice(source.indexOf('function sessionContextKey'), source.indexOf('function invalidateSessionContext'));
  for (const field of ['workspace', 'binary', 'attach', 'sessionRef', 'connectionMode', 'sessionId', 'limit']) {
    assert.match(keyHelper, new RegExp(`input\\.${field}`, 'u'));
  }
  assert.doesNotMatch(compiled, /^\s*import\s+[\s\S]*?from\s+['"]\.\.\//mu);
});

test('renderer invalida respuesta y mensajes al aceptar una conexión nueva', async () => {
  const source = await readFile(path.join(root, 'src', 'desktop', 'renderer', 'app.ts'), 'utf8');
  const invalidation = source.slice(source.indexOf('function invalidateSessionContext'), source.indexOf('function errorText'));
  assert.match(invalidation, /contextRequestId\+\+/u);
  assert.match(invalidation, /contextConnectionKey = null/u);
  assert.match(invalidation, /contextSessionId = null/u);
  assert.match(invalidation, /contextMessages = \[\]/u);
  const loader = source.slice(source.indexOf('async function loadSessions'), source.indexOf('async function submitRun'));
  assert.match(loader, /invalidateSessionContext\(\);\s*sessionConnection = \{ \.\.\.input \}/u);
  const submit = source.slice(source.indexOf('async function submitRun'), source.indexOf('async function disableContinuous'));
  assert.match(submit, /selectedRunId = receipt\.runId;\s*selectedSessionId = null;\s*invalidateSessionContext\(\)/u);
  const contextLoader = source.slice(source.indexOf('async function loadSessionContext'), source.indexOf('function renderSessionList'));
  assert.match(contextLoader, /sessionContextKey\(currentTarget\) !== targetKey/u);
});

test('contexto acepta envelope, conserva orden y toma solo los mensajes humanos más recientes', () => {
  const payload = { data: [
    { info: { role: 'user' }, parts: [{ type: 'text', text: ' antiguo ' }] },
    { info: { role: 'tool' }, parts: [{ type: 'text', text: 'tool-secret' }] },
    { info: { role: 'assistant', synthetic: true }, text: 'synthetic-secret' },
    {
      info: { role: 'user' },
      parts: [
        { type: 'text', text: ' objetivo reciente ' },
        { type: 'tool', text: 'tool-part-secret' },
      ],
    },
    { role: 'assistant', text: ' respuesta reciente ' },
  ] };
  const original = structuredClone(payload);
  const context = parseSessionContextPayload('ses_Context2', payload, 2);

  assert.deepEqual(context, {
    sessionId: 'ses_Context2',
    messages: [
      { role: 'user', text: 'objetivo reciente' },
      { role: 'assistant', text: 'respuesta reciente' },
    ],
  });
  assert.deepEqual(payload, original);
  assert.equal(JSON.stringify(context).includes('secret'), false);
});

test('contexto aplica límites por mensaje y global desde los mensajes más nuevos', () => {
  const payload = Array.from({ length: 8 }, (_, index) => ({
    info: { role: index % 2 === 0 ? 'user' : 'assistant' },
    parts: [{ type: 'text', text: `${index}`.repeat(5_000) }],
  }));
  const context = parseSessionContextPayload('ses_Context3', payload, 20);
  assert.equal(context.messages.length, 6);
  assert.equal(context.messages[0].text[0], '2');
  assert.equal(context.messages.at(-1).text[0], '7');
  assert.equal(context.messages.every((message) => message.text.length === 4_000), true);
  assert.equal(context.messages.reduce((sum, message) => sum + message.text.length, 0), 24_000);
});
