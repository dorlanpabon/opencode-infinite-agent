const path = require('path');
const fs = require('fs');
const os = require('os');
const log = require('../src/log');
const { loadConfig } = require('../src/config');
const server = require('../src/server');
const { resolveSession, initialPrompt } = require('../src/session');

// Sonda de permisos: proyecto SIN opencode.json de permisos => el agente dispara
// "permission.asked". Capturamos el payload crudo del SSE y probamos los dos
// endpoints de respuesta (nuevo /permission/:id/reply y viejo por sesion).
(async () => {
  const proj = path.join(__dirname, '..', 'test', 'perm-probe-proj');
  const sidecar = !!process.env.PROBE_SIDECAR;
  const cfg = loadConfig({ port: process.env.PROBE_PORT || 4578, dir: proj, verbose: true });
  cfg.discover = sidecar;
  const task = sidecar
    ? 'Crea el archivo C:\\Users\\-\\.config\\opencode\\loop-agent-probe.txt con el contenido exacto PERM_PROBE_OK y verificalo leyendolo.'
    : 'Crea el archivo probe.txt en la raiz del proyecto con el contenido exacto PERM_PROBE_OK.';
  let handle;
  const seen = [];
  let repliedVia = null;

  async function captureEvents(base) {
    const ctl = new AbortController();
    const res = await fetch(base.replace(/\/$/, '') + '/event', {
      signal: ctl.signal,
      headers: { accept: 'text/event-stream', ...server.authHeaders(base) },
    });
    if (!res.ok || !res.body) throw new Error(`SSE no disponible (${res.status})`);
    (async () => {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim());
            const t = String(ev.type || ev.name || '');
            if (/permission/i.test(t)) {
              seen.push(ev);
              console.log('\n=== EVENTO PERMISO CRUDO ===');
              console.log(JSON.stringify(ev, null, 2));
            }
          } catch {}
        }
      }
    })().catch(() => {});
    return ctl;
  }

  async function replyPermission(req, base, sessionId, pid) {
    try {
      await server.request(base, 'POST', `/permission/${pid}/reply`, { reply: 'once' }, { timeoutMs: 10000 });
      repliedVia = '/permission/:id/reply';
      return;
    } catch (e) {
      console.log(`endpoint nuevo fallo: ${e.message}`);
    }
    try {
      await server.request(base, 'POST', `/session/${sessionId}/permissions/${pid}`, { response: 'once' }, { timeoutMs: 10000 });
      repliedVia = '/session/:id/permissions/:id';
    } catch (e) {
      console.log(`endpoint viejo fallo: ${e.message}`);
      throw e;
    }
  }

  try {
    handle = await server.ensureServer(cfg, log);
    const req = (m, p, b, o) => server.request(handle.base, m, p, b, o);

    const evtCtl = await captureEvents(handle.base);

    const { session } = await resolveSession(req, { ref: null, title: 'perm-probe' });
    console.log('PROBE sesion:', session.id, sidecar ? '(sidecar app escritorio)' : '(CLI dedicado)');

    await req('POST', `/session/${session.id}/prompt_async`, {
      parts: [{ type: 'text', text: initialPrompt(task, '[TASK_COMPLETE]') }],
    }, { timeoutMs: 15000 });

    const deadline = Date.now() + 180 * 1000;
    let done = false;
    while (Date.now() < deadline && !done) {
      await new Promise((r) => setTimeout(r, 2000));
      for (const ev of seen.splice(0)) {
        const payload = ev.properties || ev.data || ev.payload || {};
        const pid = payload.id || payload.permissionID;
        const sid = payload.sessionID || session.id;
        if (pid && sid && !repliedVia) {
          try {
            await replyPermission(req, handle.base, sid, pid);
            console.log('RESPONDIDO VIA:', repliedVia);
          } catch {}
        }
      }
      const msgs = await req('GET', `/session/${session.id}/message`);
      const last = (Array.isArray(msgs) ? msgs : []).filter((m) => m.info && m.info.role === 'assistant').pop();
      const text = (last?.parts || []).filter((p) => p.type === 'text').map((p) => p.text || '').join('\n');
      if (text.includes('[TASK_COMPLETE]')) {
        console.log('PROBE agente termino:', text.slice(0, 200));
        done = true;
      }
      if (!done && Date.now() > deadline - 175000 && seen.length === 0 && !repliedVia) {
        console.log('...esperando eventos de permiso...');
      }
    }

    const file = sidecar
      ? 'C:\\Users\\-\\.config\\opencode\\loop-agent-probe.txt'
      : path.join(proj, 'probe.txt');
    console.log(done ? 'PROBE_OK' : 'PROBE_TIMEOUT');
    console.log('probe.txt existe:', fs.existsSync(file), fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
    evtCtl.abort();
    try { await req('POST', `/session/${session.id}/abort`, {}); } catch {}
    try { await req('DELETE', `/session/${session.id}`); } catch {}
    if (!done) process.exitCode = 1;
  } catch (e) {
    console.error('PROBE_FAIL:', e.message);
    process.exitCode = 1;
  } finally {
    await server.stopServer(handle);
  }
})();
