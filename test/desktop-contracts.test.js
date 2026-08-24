const assert = require('node:assert/strict');
const test = require('node:test');
const {
  parseDoctorInput,
  parseSessionConnectionInput,
  parseSetContinuousInput,
  parseStartRunInput,
} = require('../dist/desktop/contracts.js');

const valid = {
  task: 'Termina la tarea y verifica el resultado',
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

test('contratos Desktop aceptan inputs exactos y acotados', () => {
  assert.deepEqual(parseStartRunInput(valid), valid);
  assert.deepEqual(parseDoctorInput({ workspace: null, binary: null, attach: null }), {
    workspace: null,
    binary: null,
    attach: null,
  });
});

test('contratos Desktop validan catálogo y modo continuo por sesión exacta', () => {
  const connection = { workspace: 'C:\\workspace', binary: null, attach: 'http://127.0.0.1:4096' };
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
    () => parseSetContinuousInput({ enabled: true, sessionId: 'ses_other', run }),
    /exactamente/iu,
  );
  assert.throws(
    () => parseSetContinuousInput({ enabled: false, sessionId: 'ses_exact123', run }),
    /no admite/iu,
  );
});

test('contratos Desktop rechazan campos extra, attach remoto y auto-approve sin confirmar', () => {
  assert.throws(() => parseStartRunInput({ ...valid, extra: true }), /inválidos/iu);
  assert.throws(() => parseStartRunInput({ ...valid, attach: 'https://example.com' }), /loopback/iu);
  assert.throws(() => parseStartRunInput({ ...valid, autoApprove: true }), /confirma/iu);
});
