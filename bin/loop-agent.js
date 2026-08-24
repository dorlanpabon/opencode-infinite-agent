#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const log = require('../src/log');
const { loadConfig } = require('../src/config');
const server = require('../src/server');
const { resolveSession, initialPrompt, resumePrompt } = require('../src/session');
const { runLoop } = require('../src/loop');
const { printReport, exitCodeFor } = require('../src/report');

const VERSION = require('../package.json').version;

const HELP = `
loop-agent v${VERSION} - Agente ilimitado sobre opencode
Ejecuta un bucle automatico sobre una sesion de opencode hasta completar la tarea.

USO:
  loop-agent --prompt "tarea..." [opciones]
  loop-agent --session ses_xxxxxxxx [opciones]
  loop-agent --deeplink "oc://renderer/server/.../session/ses_xxxxxxxx" [opciones]
  loop-agent init-permissions --confirm-unsafe [--dir <ruta>]

COMANDOS:
  init-permissions    Crea/fusiona opencode.json en --dir (o cwd) con permisos
                      allow-all: edit, bash, webfetch y external_directory.
                      Requiere --confirm-unsafe porque elimina barreras del proyecto.

MODOS:
  --prompt <texto>       Tarea nueva (crea sesion). Obligatoria si no hay session/deeplink.
  --session <id>         Reanudar una sesion existente por ID.
  --deeplink <url>       Reanudar sesion extrayendo el ID desde un deeplink oc://...

OPCIONES PRINCIPALES:
  --dir <ruta>           Directorio del proyecto donde trabaja opencode (default: cwd)
  --model <prov/mod>     Modelo a usar, ej: anthropic/claude-sonnet-4-5
  --agent <nombre>       Agente de opencode a usar
  --title <texto>        Titulo para la sesion nueva
  --config <ruta>        Ruta alternativa al archivo .looprc.json

LIMITES Y SEGURIDAD:
  --max-iterations <n>   Maximo de iteraciones del bucle (default: 100)
  --delay-ms <ms>        Compatibilidad: ignorado; la continuación depende de eventos
  --retries <n>          Reintentos por iteracion ante fallos transitorios (default: 3)
  --stall-timeout-min <m> Tiempo maximo esperando respuesta por iteracion (default: 20)
  --sentinel <marcador>  Marcador de finalizacion (default: "[TASK_COMPLETE]")
  --no-todos             Desactiva deteccion por lista de todos
  --auto-approve         Aprueba automaticamente peticiones de permisos (headless)
  --no-discover          No buscar servidores opencode ya corriendo; lanza uno dedicado

SERVIDOR:
  --port <n>             Puerto del servidor headless (default: 4567 o LOOP_PORT)
  --hostname <host>      Hostname (default: 127.0.0.1)
  --attach <url>         Adjuntarse a un servidor opencode ya corriendo
                         (ej: http://127.0.0.1:4096; usa OPENCODE_SERVER_PASSWORD si tiene auth)
  --keep-server          No apagar el servidor headless al terminar

OTROS:
  --verbose              Log detallado (DEBUG)
  -h, --help             Esta ayuda
  -v, --version          Version

CONFIG POR ARCHIVO (.looprc.json en --dir o en la raiz de esta herramienta),
VARIABLES DE ENTORNO: LOOP_PORT, LOOP_SENTINEL, OPENCODE_BIN,
OPENCODE_SERVER_PASSWORD / OPENCODE_SERVER_USERNAME (basic auth).

CODIGOS DE SALIDA: 0=completada, 1=error, 2=limite de iteraciones, 130=interrumpida.
`;

function parseArgs(argv) {
  const args = {};
  const withValue = new Set([
    '--dir', '--prompt', '--prompt-file', '--session', '--deeplink', '--model', '--agent',
    '--title', '--config', '--port', '--hostname', '--max-iterations', '--delay-ms',
    '--retries', '--retry-delay-ms', '--stall-timeout-min', '--sentinel', '--attach',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { args.help = true; continue; }
    if (a === '-v' || a === '--version') { args.version = true; continue; }
    if (!a.startsWith('--')) throw new Error(`Argumento inesperado: ${a}`);
    if (a === '--no-todos') { args.noTodos = true; continue; }
    if (a === '--auto-approve') { args.autoApprove = true; continue; }
    if (a === '--no-discover') { args.noDiscover = true; continue; }
    if (a === '--keep-server') { args.keepServer = true; continue; }
    if (a === '--verbose') { args.verbose = true; continue; }
    if (!withValue.has(a)) throw new Error(`Flag desconocido: ${a}`);
    const value = argv[++i];
    if (value == null) throw new Error(`Falta valor para ${a}`);
    args[a.slice(2)] = value;
  }
  return args;
}

function normalizeKeys(args) {
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    out[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
  }
  return out;
}

// pre-autoriza permisos en el proyecto para evitar dialogos "Permission required"
function runInitPermissions(argv) {
  let dir = process.cwd();
  let confirmed = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir' && argv[i + 1]) { dir = path.resolve(argv[++i]); }
    if (argv[i] === '--confirm-unsafe') confirmed = true;
    if (argv[i] === '-h' || argv[i] === '--help') { console.log('Uso: loop-agent init-permissions --confirm-unsafe [--dir <ruta>]'); process.exit(0); }
  }
  if (!confirmed) {
    log.err('init-permissions habilita bash y acceso externo sin confirmación. Repite con --confirm-unsafe si aceptas ese riesgo.');
    process.exit(1);
  }
  if (!fs.existsSync(dir)) {
    log.err(`El directorio no existe: ${dir}`);
    process.exit(1);
  }
  const file = path.join(dir, 'opencode.json');
  let cfgJson = {};
  if (fs.existsSync(file)) {
    try {
      // tolera BOM UTF-8 que muchos editores de Windows agregan
      const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
      cfgJson = raw ? JSON.parse(raw) : {};
    } catch {
      log.err(`opencode.json existente no es JSON valido: ${file}`);
      process.exit(1);
    }
  }
  cfgJson.$schema = cfgJson.$schema || 'https://opencode.ai/config.json';
  cfgJson.permission = { ...(cfgJson.permission || {}) };
  cfgJson.permission.edit = 'allow';
  cfgJson.permission.bash = { '*': 'allow', ...(typeof cfgJson.permission.bash === 'object' ? cfgJson.permission.bash : {}) };
  cfgJson.permission.webfetch = 'allow';
  cfgJson.permission.external_directory = { '**': 'allow', ...(typeof cfgJson.permission.external_directory === 'object' ? cfgJson.permission.external_directory : {}) };
  fs.writeFileSync(file, JSON.stringify(cfgJson, null, 2) + '\n');
  log.ok(`Permisos pre-autorizados en: ${file}`);
  console.log('  edit=allow | bash=allow-all | webfetch=allow | external_directory=allow');
  process.exit(0);
}

async function main() {
  // subcomando: init-permissions (no requiere servidor ni sesion)
  if (process.argv[2] === 'init-permissions') {
    runInitPermissions(process.argv.slice(3));
    return;
  }

  let args;
  try {
    args = normalizeKeys(parseArgs(process.argv.slice(2)));
  } catch (e) {
    log.err(e.message);
    console.log(HELP);
    process.exit(1);
  }

  if (args.help) { console.log(HELP); process.exit(0); }
  if (args.version) { console.log(`loop-agent v${VERSION}`); process.exit(0); }

  // carga tarea desde archivo antes de validar
  if (args.promptFile) {
    try {
      args.prompt = fs.readFileSync(path.resolve(args.promptFile), 'utf8');
    } catch (e) {
      log.err(`No se pudo leer --prompt-file: ${e.message}`);
      process.exit(1);
    }
  }

  // requiere prompt o referencia de sesion
  const ref = args.deeplink || args.session || null;
  if (!args.prompt && !ref) {
    log.err('Debes indicar --prompt (tarea nueva) o --session/--deeplink (reanudar).');
    console.log(HELP);
    process.exit(1);
  }

  const cfg = loadConfig(args);
  log.setVerbose(cfg.verbose);
  if (cfg.configFileUsed) log.debug(`Config cargada desde: ${cfg.configFileUsed}`);

  log.banner('opencode-infinite-agent');
  console.log(`Servidor : ${cfg.base}`);
  console.log(`Proyecto : ${args.dir ? path.resolve(args.dir) : process.cwd()}`);
  console.log(`Sentinel : ${cfg.sentinel}`);
  console.log(`Todos    : ${cfg.todoDetection ? 'activado' : 'desactivado'} | Auto-aprobar: ${cfg.autoApprove ? 'si' : 'no'}`);
  console.log('Motor    : SSE event-driven (sin mensajes por intervalo)');

  // levanta o se adjunta al servidor headless
  let handle;
  try {
    handle = await server.ensureServer(cfg, log);
  } catch (e) {
    log.err(`Servidor: ${e.message}`);
    process.exit(1);
  }

  const req = (method, p, body, opts) => server.request(handle.base, method, p, body, opts);

  // resuelve o crea la sesion
  let session;
  try {
    const r = await resolveSession(req, {
      ref,
      title: cfg.title || (args.prompt ? `loop: ${args.prompt.slice(0, 60)}` : undefined),
    });
    session = r.session;
    log.ok(`${r.created ? 'Sesion creada' : 'Sesion reanudada'}: ${session.id}${session.title ? ` ("${session.title}")` : ''}`);
  } catch (e) {
    log.err(`Sesion: ${e.message}`);
    await server.stopServer(handle);
    process.exit(1);
  }

  // Un solo stream SSE compartido por el monitor de turno y auto-approve.
  // Se inicia despues de resolver la sesion para filtrar permisos exactamente.
  const eventStream = server.startEventStream({
    base: handle.base,
    debug: log.debug,
  });
  let approverCtl = null;
  if (cfg.autoApprove) {
    approverCtl = server.startPermissionApprover({
      base: handle.base,
      eventStream,
      sessionId: session.id,
      onResponseSent: (sid, pid) => log.warn(`Permiso auto-aprobado (${pid}) en sesion ${sid}`),
      debug: log.debug,
    });
  }

  // primer mensaje: tarea nueva con protocolo, o recordatorio de reanudacion
  const firstPrompt = args.prompt
    ? initialPrompt(args.prompt, cfg.sentinel)
    : resumePrompt(cfg.sentinel);

  // Ctrl+C: aborta limpio la sesion y sale con codigo 130 tras el reporte
  const abortCtl = new AbortController();
  const flag = { aborted: false, signal: abortCtl.signal };
  let interrupts = 0;
  const onSignal = async () => {
    interrupts++;
    if (interrupts === 1) {
      flag.aborted = true;
      abortCtl.abort();
      log.warn('Ctrl+C: abortando sesion y cerrando... (pulsa otra vez para forzar)');
      try { await req('POST', `/session/${session.id}/abort`, {}, { timeoutMs: 5000 }); } catch {}
    } else {
      process.exit(130);
    }
  };
  process.on('SIGINT', onSignal);
  if (process.platform === 'win32') process.on('SIGBREAK', onSignal);

  // ejecuta el bucle infinito
  const result = await runLoop({
    req, sessionId: session.id, cfg, firstPrompt, flag, log, eventStream, resumeExisting: !args.prompt,
  });

  if (approverCtl) approverCtl.abort();
  eventStream.abort();
  printReport({ status: result.status, reason: result.reason, state: result.state, sessionId: session.id, cfg }, log);

  if (!cfg.keepServer && handle.owned) {
    log.info('Apagando servidor headless...');
    await server.stopServer(handle);
  } else if (handle.owned) {
    log.info(`Servidor dejado corriendo en ${handle.base} (--keep-server)`);
  }

  process.exit(exitCodeFor(result.status));
}

main().catch((e) => {
  log.err(`Error fatal: ${e.stack || e.message}`);
  process.exit(1);
});
