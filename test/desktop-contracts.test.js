const assert = require('node:assert/strict');
const test = require('node:test');
const {
  parseDoctorInput,
  buildRunDeepLink,
  buildSessionDeepLink,
  parseCopySessionLinkInput,
  parseOpenProjectInput,
  parseDeepLink,
  parseResumeRunInput,
  parseSessionContextInput,
  parseSessionConnectionInput,
  parseSetContinuousInput,
  parseStartRunInput,
} = require('../dist/desktop/contracts.js');

const valid = {
  task: 'Termina la tarea y verifica el resultado',
  attachments: [],
  workspace: 'C:\\workspace',
  name: null,
  sessionRef: null,
  model: null,
  agent: null,
  binary: null,
  attach: null,
  maxIterations: 100,
  maxHours: 8,
  stallMinutes: 20,
  sentinel: '[TASK_COMPLETE]',
  todoDetection: true,
  autoApprove: false,
  autoApproveConfirmation: false,
  resumeExisting: false,
};

test('contratos Desktop aceptan inputs exactos y objetivo sin límite artificial', () => {
  assert.deepEqual(parseStartRunInput(valid), valid);
  assert.equal(parseStartRunInput({ ...valid, task: 'x'.repeat(80_000) }).task.length, 80_000);
  const attachment = { path: 'C:\\workspace\\brief.pdf', name: 'brief.pdf', mime: 'application/pdf', size: 1024 };
  assert.deepEqual(parseStartRunInput({ ...valid, attachments: [attachment] }).attachments, [attachment]);
  assert.deepEqual(parseDoctorInput({ workspace: null, binary: null, attach: null }), {
    workspace: null,
    binary: null,
    attach: null,
  });
});

test('contratos Desktop validan catálogo y modo continuo por sesión exacta', () => {
  const connection = {
    workspace: 'C:\\workspace', binary: null, attach: 'http://127.0.0.1:4096', sessionRef: 'oc://renderer/server/c2lkZWNhcg/session/ses_exact123',
  };
  assert.deepEqual(parseSessionConnectionInput(connection), connection);
  const run = { ...valid, sessionRef: 'ses_exact123', resumeExisting: true };
  assert.deepEqual(
    parseSetContinuousInput({ enabled: true, sessionId: 'ses_exact123', run }),
    { enabled: true, sessionId: 'ses_exact123', run },
  );
  assert.deepEqual(
    parseSetContinuousInput({ enabled: false, sessionId: 'ses_exact123', run: null }),
    { enabled: false, sessionId: 'ses_exact123', run: null },
  );
  assert.throws(
    () => parseSetContinuousInput({
      enabled: true,
      sessionId: 'ses_exact123',
      run: { ...run, autoApprove: true, autoApproveConfirmation: true },
    }),
    /permisos.*OpenCode Desktop/iu,
  );
  assert.throws(
    () => parseSetContinuousInput({ enabled: true, sessionId: 'ses_other', run }),
    /exactamente/iu,
  );
  assert.throws(
    () => parseSetContinuousInput({ enabled: false, sessionId: 'ses_exact123', run }),
    /no admite/iu,
  );

  for (const sessionRef of [
    'prefix-ses_exact123',
    'oc://evil/server/c2lkZWNhcg/session/ses_exact123',
    'oc://renderer/server/otro/session/ses_exact123',
    'oc://renderer/server/c2lkZWNhcg/session/ses_exact123?token=secret',
    'oc://renderer/server/c2lkZWNhcg/session/ses_exact123/message',
  ]) {
    assert.throws(
      () => parseSessionConnectionInput({ ...connection, sessionRef }),
      /enlace interno.*válido/iu,
      sessionRef,
    );
    assert.throws(() => parseStartRunInput({ ...valid, sessionRef }), /enlace interno.*válido/iu, sessionRef);
  }
});

test('contratos Desktop aíslan las acciones de navegación por sesión', () => {
  assert.deepEqual(parseOpenProjectInput({ workspace: 'C:\\workspace' }), { workspace: 'C:\\workspace' });
  assert.deepEqual(parseCopySessionLinkInput({ sessionId: 'ses_exact123' }), { sessionId: 'ses_exact123' });
  assert.throws(() => parseOpenProjectInput({ workspace: 'C:\\workspace', url: 'https://example.com' }), /inválidos/iu);
  assert.throws(() => parseCopySessionLinkInput({ sessionId: 'ses_exact123', token: 'secret' }), /inválidos/iu);
  assert.throws(() => parseCopySessionLinkInput({ sessionId: 'ses_bad/route' }), /Session ID/iu);
});

test('contratos Desktop rechazan campos extra, attach remoto y auto-approve sin confirmar', () => {
  assert.throws(() => parseStartRunInput({ ...valid, extra: true }), /inválidos/iu);
  assert.throws(() => parseStartRunInput({ ...valid, attach: 'https://example.com' }), /loopback/iu);
  assert.throws(() => parseStartRunInput({ ...valid, autoApprove: true }), /confirma/iu);
  assert.throws(() => parseStartRunInput({ ...valid, attachments: [{ path: 'brief.pdf' }] }), /adjuntos/iu);
});

test('deeplinks Infinite son estrictos, totales y no codifican acciones', () => {
  const runId = '123e4567-e89b-42d3-a456-426614174000';
  assert.equal(buildRunDeepLink(runId), `opencode-infinite://run/${runId}`);
  assert.equal(buildSessionDeepLink('ses_exact123'), 'opencode-infinite://session/ses_exact123');
  assert.deepEqual(parseDeepLink(`opencode-infinite://run/${runId}`), { kind: 'run', id: runId });
  assert.deepEqual(parseDeepLink('opencode-infinite://session/ses_exact123'), { kind: 'session', id: 'ses_exact123' });
  for (const invalid of [
    `opencode-infinite://run/${runId}?resume=true`,
    `opencode-infinite://run/${runId}/resume`,
    'opencode-infinite://session/ses_exact123#start',
    'opencode-infinite://session/%73es_exact123',
    'opencode-infinite://session/%E0%A4%A',
    'https://run/123e4567-e89b-42d3-a456-426614174000',
  ]) assert.equal(parseDeepLink(invalid), null, invalid);
  assert.equal(parseDeepLink({ url: 'opencode-infinite://session/ses_exact123' }), null);
});

test('reanudar exige confirmación y contexto limita conexión, sesión y cantidad', () => {
  const runId = '123e4567-e89b-42d3-a456-426614174000';
  assert.deepEqual(parseResumeRunInput({ runId, confirmed: true }), { runId, confirmed: true });
  assert.throws(() => parseResumeRunInput({ runId, confirmed: false }), /confirmación/iu);
  const context = {
    workspace: 'C:\\workspace', binary: null, attach: null, sessionRef: 'ses_exact123',
    connectionMode: 'desktop-sidecar', sessionId: 'ses_exact123', limit: 20,
  };
  assert.deepEqual(parseSessionContextInput(context), context);
  const internalContext = {
    ...context,
    sessionRef: 'oc://renderer/server/c2lkZWNhcg/session/ses_exact123',
    connectionMode: 'dedicated',
  };
  assert.deepEqual(parseSessionContextInput(internalContext), internalContext);
  assert.throws(() => parseSessionContextInput({ ...context, limit: 21 }), /contexto/iu);
  assert.throws(() => parseSessionContextInput({ ...context, connectionMode: 'remote' }), /contexto/iu);
  assert.throws(() => parseSessionContextInput({ ...context, connectionMode: 'attach' }), /contexto/iu);
  assert.throws(() => parseSessionContextInput({ ...context, sessionRef: 'ses_other123' }), /contexto/iu);
  assert.throws(() => parseSessionContextInput({ ...internalContext, sessionId: 'ses_other123' }), /contexto/iu);
});
