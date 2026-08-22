const path = require('path');
const log = require('../src/log');
const { loadConfig } = require('../src/config');
const server = require('../src/server');
const { resolveSession } = require('../src/session');

// Smoke test de infraestructura: NO consume tokens de LLM.
// 1) levanta/adjunta servidor headless, 2) crea sesion, 3) consulta todo y mensajes,
// 4) elimina la sesion, 5) apaga el servidor propio.
(async () => {
  const cfg = loadConfig({ port: process.env.SMOKE_PORT || 4577, verbose: true });
  let handle;
  try {
    handle = await server.ensureServer(cfg, log);
    const req = (method, p, body, opts) => server.request(handle.base, method, p, body, opts);

    const { session, created } = await resolveSession(req, { ref: null, title: 'smoke-test' });
    console.log('SMOKE sesion:', created ? 'creada' : 'adjunta', session.id);

    const todos = await req('GET', `/session/${session.id}/todo`);
    console.log('SMOKE todos:', JSON.stringify(todos));

    const msgs = await req('GET', `/session/${session.id}/message`);
    console.log('SMOKE mensajes:', Array.isArray(msgs) ? msgs.length : '?');

    const agents = await req('GET', '/agent');
    console.log('SMOKE agentes:', Array.isArray(agents) ? agents.map((a) => a.name).join(', ') : '?');

    await req('DELETE', `/session/${session.id}`);
    console.log('SMOKE sesion eliminada');

    console.log('SMOKE_OK');
  } catch (e) {
    console.error('SMOKE_FAIL:', e.message);
    process.exitCode = 1;
  } finally {
    await server.stopServer(handle);
  }
})();
