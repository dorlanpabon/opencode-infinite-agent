# opencode-infinite-agent

**Agente ilimitado para [opencode](https://opencode.ai): un bucle automático sobre una sesión que no se detiene hasta que la tarea esté completamente terminada.**

La herramienta lanza (o se adjunta a) un servidor headless de opencode, crea o reanuda una sesión, y le envía mensajes de continuación en bucle hasta detectar finalización real mediante **doble señal**: el marcador `[TASK_COMPLETE]` en la respuesta del agente y/o la lista de todos de la sesión completamente marcada como completada.

---

## Requisitos

- Node.js >= 18
- opencode instalado y autenticado (`opencode auth login`). Si no está en PATH, define `OPENCODE_BIN`.
- Permisos del proyecto configurados para ejecución headless (ver [Permisos en modo headless](#permisos-en-modo-headless)).

## Uso rápido

```bash
# 1) Tarea nueva en cualquier proyecto
node bin/loop-agent.js --dir "D:\mi\proyecto" --prompt "Construye una API REST completa con tests"

# 2) Reanudar tu sesión actual (por deeplink) hasta terminarla
node bin/loop-agent.js --deeplink "oc://renderer/server/c2lkZWNhcg/session/ses_xxxxxxxx" --dir "D:\mi\proyecto"

# 3) Por ID de sesion
node bin/loop-agent.js --session ses_fd8e5dbeeffeuDpQFM6wZ8o7cu --dir "D:\mi\proyecto"

# Recomendado en proyectos con permisos restrictivos:
node bin/loop-agent.js --dir "D:\mi\proyecto" --prompt "..." --auto-approve --max-iterations 200
```

### Códigos de salida

| Código | Significado |
|--------|-------------|
| `0`    | Tarea COMPLETADA |
| `1`    | Error fatal |
| `2`    | Límite de iteraciones alcanzado sin terminar |
| `130`  | Interrumpido por el usuario (Ctrl+C) |

## Cómo funciona

```
┌────────────────────────────────────────────────────────────┐
│ 1. Conexion (en orden):                                    │
│    a. --attach <url> explicito                             │
│    b. health en puerto configurado                         │
│    c. descubrimiento de procesos opencode locales          │
│       (TUI o sidecar de la app escritorio)                 │
│    d. spawn dedicado: `opencode serve --port N`            │
│       con cwd = --dir (reintento con config aislada        │
│       si el config global es incompatible)                 │
│ 2. Sesion:                                                 │
│      POST /session            (modo tarea nueva)           │
│      GET  /session/:id        (modo reanudar, valida ID)   │
│ 3. BUCLE (hasta maxIterations):                            │
│      POST /session/:id/prompt_async  ("continúa...")       │
│      poll GET /session/:id/message  → respuesta nueva      │
│      ├─ ¿[TASK_COMPLETE] en texto?  → FIN ✅               │
│      ├─ GET /session/:id/todo       → ¿todos completed? ✅ │
│      ├─ ¿error transitorio?         → retry con backoff    │
│      └─ pausa delayMs y repite                             │
│ 4. Ctrl+C → POST /session/:id/abort + reporte + exit(130)  │
│ 5. Reporte: iteraciones, tokens, costo $, último mensaje   │
└────────────────────────────────────────────────────────────┘
```

Endpoints del servidor usados: `/global/health`, `/session`, `/session/:id`, `/session/:id/message`, `/session/:id/prompt_async`, `/session/:id/todo`, `/session/:id/abort`, `/event` (SSE para auto-aprobar permisos). Especificación completa: `http://localhost:<puerto>/doc`.

### Detección de finalización (doble señal)

1. **Sentinel**: el prompt inicial instruye al agente a terminar su respuesta con `[TASK_COMPLETE]` (configurable) solo cuando todo esté 100% completo y verificado.
2. **Todos**: consulta `GET /session/:id/todo`; si existen todos y todos están en estado `completed` (o `cancelled`), también se considera terminada.

Con ambas señales activas basta una para detener el bucle; puedes desactivar la de todos con `--no-todos`.

## Configuración

Busca `.looprc.json` primero en `--dir` y luego en la raíz de esta herramienta. Ejemplo (cópialo desde `.looprc.example.json`):

```json
{
  "port": 4567,
  "hostname": "127.0.0.1",
  "maxIterations": 100,
  "delayMs": 4000,
  "retries": 3,
  "retryDelayMs": 4000,
  "maxConsecutiveErrors": 4,
  "stallTimeoutMin": 20,
  "pollMs": 2000,
  "sentinel": "[TASK_COMPLETE]",
  "todoDetection": true,
  "autoApprove": false,
  "keepServer": false,
  "verbose": false,
  "model": null,
  "agent": null,
  "title": null
}
```

Variables de entorno soportadas:

| Variable | Descripción |
|----------|-------------|
| `LOOP_PORT` | Puerto por defecto del servidor headless |
| `LOOP_SENTINEL` | Marcador de finalización alternativo |
| `OPENCODE_BIN` | Ruta al binario opencode si no está en PATH |
| `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME` | Basic auth si tu servidor la requiere |

Precedencia: CLI > entorno > archivo > defaults.

## Permisos en modo headless

Un servidor headless no puede preguntarte permisos por terminal. Dos opciones:

1. **Recomendada**: configura permisos en el `opencode.json` del proyecto:
   ```json
   {
     "permission": { "edit": "allow", "bash": { "*": "allow" } }
   }
   ```
2. O usa `--auto-approve`: la herramienta escucha el stream `/event` y responde automáticamente las peticiones de permiso (respuesta `once`).

## Instalación global (opcional)

```bash
cd D:\xampp\htdocs\opencode_infinite_agent
npm install -g .
loop-agent --help
```

## Solución de problemas

| Problema | Solución |
|----------|----------|
| `No se encontro el binario "opencode"` | Define `OPENCODE_BIN` o instala opencode |
| `El config global de opencode es invalido` | La herramienta lo resuelve sola: reintenta con una configuracion aislada temporal (`XDG_CONFIG_HOME`). Nota: en ese modo los MCPs del config global no cargan en el servidor dedicado |
| El agente no crea archivos en tu proyecto con servidor dedicado | Asegurate de pasar `--dir` apuntando al proyecto; el servidor headless hereda ese directorio como raiz |
| El servidor no responde tras 90s | Prueba otro puerto: `--port 4568`; revisa que no haya firewall bloqueando localhost |
| La sesión queda esperando sin avanzar | Probablemente un permiso pendiente: usa `--auto-approve` o ajusta permisos del proyecto |
| Respuestas vacías repetidas | Verifica autenticación del proveedor (`opencode auth login`) y prueba `--model proveedor/modelo` |
| Quiero dejar el servidor vivo entre corridas | `--keep-server` |

## Estructura del proyecto

```
opencode_infinite_agent/
├── bin/loop-agent.js      # CLI principal
├── src/
│   ├── config.js          # defaults + .looprc.json + env + flags
│   ├── log.js             # logging con colores
│   ├── server.js          # health-check, spawn serve, HTTP client, SSE
│   ├── session.js         # crear/reanudar sesiones, prompts del protocolo
│   ├── loop.js            # motor del bucle infinito
│   ├── detect.js          # sentinel, todos, tokens/costo
│   └── report.js          # reporte final
├── .looprc.example.json   # plantilla de configuracion
└── PROGRESS.md            # registro de avance del proyecto
```
