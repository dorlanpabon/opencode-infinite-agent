# OpenCode Infinite

Supervisor de escritorio, local y orientado a eventos para llevar sesiones de OpenCode hasta una finalización verificable. Incluye una aplicación gráfica para Windows, macOS y Linux, además del CLI `loop-agent` para automatización.

No envía mensajes cada *X* segundos. Envía exactamente un prompt con un nonce criptográfico ignorado por el modelo, observa el stream SSE de OpenCode y solo continúa cuando coinciden tres hechos de esa sesión:

1. OpenCode persiste el mensaje de usuario con ese nonce único;
2. existe una respuesta terminal cuyo `parentID` apunta a ese mensaje;
3. OpenCode informa que la sesión quedó `idle`.

Después evalúa el marcador de finalización y los *todos*. Si la tarea sigue incompleta, envía la siguiente continuación inmediatamente. Los temporizadores son límites de seguridad: nunca disparan mensajes.

## Descargar la aplicación

Los instaladores de cada versión están en [GitHub Releases](https://github.com/dorlanpabon/opencode-infinite-agent/releases):

| Sistema | Arquitectura | Artefacto |
| --- | --- | --- |
| Windows | x64 | `OpenCode-Infinite-*-windows-x64-Setup.exe` |
| macOS | Apple Silicon | `OpenCode-Infinite-*-macos-arm64.zip` |
| macOS | Intel | `OpenCode-Infinite-*-macos-x64.zip` |
| Debian/Ubuntu | x64 / ARM64 | `OpenCode-Infinite-*-linux-*.deb` |
| Fedora/RHEL | x64 / ARM64 | `OpenCode-Infinite-*-linux-*.rpm` |

La versión estable `2.4.0` se distribuye sin certificado comercial de Windows ni firma o notarización de Apple. SmartScreen o Gatekeeper pueden mostrar una advertencia. Comprueba siempre `SHA256SUMS.txt` antes de instalar.

## Requisitos

- OpenCode instalado y autenticado en el equipo.
- Para desarrollo: Node.js 22 LTS y npm.
- El workspace debe permitir las herramientas que la tarea necesite.

La aplicación se integra con el proceso propietario de OpenCode Desktop mediante un plugin local autenticado y también puede adjuntarse manualmente a un servidor existente. Por seguridad, solo acepta orígenes loopback (`127.0.0.1`, `localhost` o `::1`) sin credenciales en la URL.

## Uso de escritorio

1. Abre primero **OpenCode Desktop** y luego **OpenCode Infinite**.
2. En **Sesiones**, pulsa **Conectar OpenCode Desktop**. La primera vez se instalará la integración local y se pedirá reiniciar OpenCode Desktop una sola vez.
3. Puedes pegar un enlace interno exacto `oc://renderer/server/c2lkZWNhcg/session/ses_…` para localizar una sesión, incluso si pertenece a otro workspace.
4. Activa **Continuar hasta terminar**, coloca el objetivo sin un límite artificial de caracteres y adjunta los archivos necesarios.
5. Para una tarea nueva, usa **Nueva ejecución**, elige el workspace y pulsa **Iniciar supervisor**.

La interfaz muestra el ciclo del turno, estado del stream, sesión, iteración, consumo, historial y logs. Solo permite una ejecución activa por instancia y conserva el estado de forma atómica para recuperarse tras un cierre. Las tareas nuevas usan un servidor dedicado; las sesiones existentes continúan dentro del sidecar que realmente las posee.

OpenCode publica únicamente `opencode://open-project?directory=...` para abrir un workspace desde el sistema operativo; **Abrir proyecto en OpenCode** usa ese protocolo. El enlace `oc://renderer/server/c2lkZWNhcg/session/<ses_id>` pertenece al renderer interno de OpenCode Desktop: OpenCode Infinite permite copiarlo o pegarlo para identificar una sesión exacta, pero nunca intenta lanzarlo como protocolo del sistema operativo.

La autoaprobación de permisos está desactivada por defecto y exige una confirmación explícita para tareas nuevas. En sesiones existentes de OpenCode Desktop, los permisos siempre se confirman dentro de OpenCode.

### Sesiones activas

La pestaña **Sesiones** agrega las sesiones raíz actuales de todos los proyectos cargados en OpenCode Desktop, combina el catálogo y los estados del SDK propietario y se mantiene al día con SSE. El interruptor **Continuar hasta terminar** abre **Coloca el objetivo para activar**, donde puedes definir el nuevo objetivo y adjuntar archivos. Si la sesión está ocupada, espera a que el turno actual sea terminal y quede `idle`; entonces vuelve a comprobar los archivos, envía el objetivo una sola vez y continúa únicamente después de cada parada real. Los adjuntos solo viajan con ese primer objetivo. Los temporizadores siguen siendo límites de seguridad y nunca envían prompts.

Desactivar el interruptor libera el supervisor local sin llamar a `/abort`, por lo que no cancela el trabajo de OpenCode. Solo puede haber una sesión supervisada por instancia. La integración descubre cada sidecar sin mostrar ni guardar sus credenciales privadas en el historial de la aplicación, usa el workspace real persistido en la sesión y enruta todas las operaciones al proceso propietario.

## Máquina de estados

```text
conectar SSE -> snapshot -> armar monitor -> POST prompt_async (una vez)
                                      |
                         busy / retry / partes de mensaje
                                      |
          respuesta terminal persistida + session.status = idle
                                      |
                        evaluar sentinel y todos
                         |                    |
                    completa              incompleta
                         |                    |
                      finalizar      enviar continuación
```

El stream se reconecta con *backoff* y vigila los *heartbeats*. Después de una reconexión, el monitor vuelve a leer mensajes y estado para reparar eventos perdidos. Un resultado ambiguo del `POST` se reconcilia sin reenviar, evitando prompts duplicados. Los límites suave y duro solo detectan un turno bloqueado; no abortan ni vuelven a enviar automáticamente.

## CLI

Desde el repositorio:

```powershell
npm ci
node bin/loop-agent.js --prompt "Implementa la tarea y verifica todo" --dir "D:\proyecto"
```

Reanudar una sesión:

```powershell
node bin/loop-agent.js --session ses_xxxxxxxx --dir "D:\proyecto"
node bin/loop-agent.js --deeplink "oc://renderer/server/c2lkZWNhcg/session/ses_xxxxxxxx" --dir "D:\proyecto"
```

Opciones relevantes:

```text
--max-iterations <n>       límite de continuaciones (100)
--stall-timeout-min <m>    aviso de inactividad; se extiende si sigue busy/retry (20)
--sentinel <texto>         marcador de finalización ([TASK_COMPLETE])
--no-todos                 desactiva finalización por todos completos
--attach <url>             servidor OpenCode local existente
--no-discover              fuerza un servidor dedicado
--auto-approve             aprueba permisos de la sesión administrada
--keep-server              conserva el servidor dedicado al terminar
```

`--delay-ms` y las claves antiguas `delayMs`/`pollMs` se aceptan únicamente por compatibilidad; no controlan ni disparan continuaciones.

Consulta todas las opciones con `node bin/loop-agent.js --help`. Puedes copiar `.looprc.example.json` como `.looprc.json` dentro del workspace.

## Finalización

Una ejecución termina correctamente al detectar cualquiera de estas señales después de un turno terminal:

- el marcador exacto, por defecto `[TASK_COMPLETE]`, en la respuesta del asistente;
- una lista no vacía de *todos* completamente terminada.

También termina de forma controlada por cancelación, límite de iteraciones, límite total de la aplicación o timeout duro del turno. El estado final indica la causa.

Las sesiones creadas antes de un *wrap* incompatible de IDs fallan de forma segura y solicitan una sesión nueva; nunca intentan continuar con una correlación dudosa.

## Permisos y seguridad

- El servidor administrado escucha solo en loopback.
- Las credenciales Basic Auth nunca se envían a un host remoto.
- Cada solicitud y el stream adjunto se enrutan al workspace exacto seleccionado.
- Cada puente de OpenCode Desktop escucha en un puerto aleatorio de `127.0.0.1`, exige un token aleatorio y solo expone las operaciones necesarias del SDK propietario.
- La autoaprobación de tareas nuevas filtra por el ID exacto de la sesión, reconcilia respuestas ambiguas y se cancela con la ejecución; no se intenta eludir el diálogo de permisos de OpenCode Desktop.
- Desktop ignora binarios definidos por el workspace salvo que el usuario seleccione uno explícitamente.
- Electron usa aislamiento de contexto, sandbox, CSP estricta, navegación bloqueada y un puente IPC mínimo con validación de entradas.
- Los logs eliminan secretos y no se guardan credenciales en el estado de ejecución.

Para crear una configuración `allow-all` del proyecto debes reconocer explícitamente el riesgo:

```powershell
node bin/loop-agent.js init-permissions --confirm-unsafe --dir "D:\proyecto"
```

Esta opción reduce las barreras de OpenCode para ese workspace. Prefiere reglas específicas y revisa el `opencode.json` resultante.

## Desarrollo

```powershell
npm ci
npm run desktop:dev
npm run check
npm run desktop:package
npm run desktop:smoke
npm run desktop:make
```

`npm run check` ejecuta TypeScript estricto, build, pruebas, validación del paquete npm y auditoría de dependencias. CI y release ejecutan el smoke de interfaz sobre la app empaquetada y, además, sobre el `.app` extraído del ZIP de macOS y los payloads extraídos de DEB y RPM. En Windows se valida y prueba el paquete portable que alimenta Squirrel; el Setup no se instala en CI para evitar cambios globales de registro, accesos directos y perfil del runner.

## Arquitectura

```text
src/agent.js                    API reutilizable del supervisor
src/turn-monitor.js             quórum de eventos + read-repair
src/server.js                   HTTP, SSE, servidor y permisos
src/loop.js                     ciclo de ejecución y finalización
src/desktop/main.ts             proceso principal Electron
src/desktop/engine-adapter.ts   adaptador in-process al motor
src/desktop/run-manager.ts      persistencia y exclusión global de ejecución
src/desktop/session-catalog.ts  catálogo de sesiones reconciliado por SSE
src/desktop/desktop-bridge.ts   descubrimiento autenticado de sidecars Desktop
src/desktop/plugin/             puente ejecutado dentro de OpenCode Desktop
src/desktop/renderer/           interfaz de usuario
```

## Licencia

[MIT](LICENSE)
