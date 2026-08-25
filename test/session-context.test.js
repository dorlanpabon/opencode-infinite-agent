const assert = require('node:assert/strict');
const test = require('node:test');
const { parseSessionContextPayload } = require('../dist/desktop/session-context.js');

test('contexto efímero conserva solo texto humano reciente dentro de límites', () => {
  const payload = [
    { info: { role: 'user' }, parts: [{ type: 'text', text: 'primero' }] },
    { info: { role: 'tool' }, parts: [{ type: 'text', text: 'tool-secret' }] },
    { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'hidden', synthetic: true }] },
    ...Array.from({ length: 7 }, (_, index) => ({
      info: { role: index % 2 === 0 ? 'user' : 'assistant' },
      parts: [{ type: 'text', text: String(index).repeat(5_000) }],
    })),
  ];
  const context = parseSessionContextPayload('ses_context1', payload, 20);
  assert.equal(context.sessionId, 'ses_context1');
  assert.equal(context.messages.length, 6);
  assert.equal(context.messages.every((message) => message.text.length === 4_000), true);
  assert.equal(context.messages.reduce((total, message) => total + message.text.length, 0), 24_000);
  assert.equal(JSON.stringify(context).includes('tool-secret'), false);
  assert.equal(JSON.stringify(context).includes('hidden'), false);
});
