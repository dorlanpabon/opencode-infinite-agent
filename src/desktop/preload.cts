import type { DesktopApi, DesktopEvent } from './contracts.js';

const { contextBridge, ipcRenderer, webUtils } = require('electron') as typeof import('electron');

const CHANNELS = Object.freeze({
  systemInfo: 'system:info',
  doctor: 'system:doctor',
  chooseWorkspace: 'workspace:choose',
  chooseBinary: 'binary:choose',
  chooseAttachments: 'attachments:choose',
  resolveDroppedAttachments: 'attachments:resolve-dropped',
  listRuns: 'runs:list',
  getRun: 'runs:get',
  listSessions: 'sessions:list',
  openOpenCodeProject: 'sessions:open-project',
  copyOpenCodeSessionLink: 'sessions:copy-internal-link',
  setContinuous: 'sessions:set-continuous',
  startRun: 'runs:start',
  stopRun: 'runs:stop',
  event: 'runs:event',
});

const EVENT_TYPES = new Set(['run-changed', 'operation-finished', 'operation-error', 'sessions-snapshot', 'log']);

function isDesktopEvent(value: unknown): value is DesktopEvent {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && EVENT_TYPES.has(String((value as { type?: unknown }).type));
}

const api: DesktopApi = {
  systemInfo: () => ipcRenderer.invoke(CHANNELS.systemInfo),
  doctor: (workspace, binary, attach) => ipcRenderer.invoke(CHANNELS.doctor, { workspace, binary, attach }),
  chooseWorkspace: () => ipcRenderer.invoke(CHANNELS.chooseWorkspace),
  chooseBinary: () => ipcRenderer.invoke(CHANNELS.chooseBinary),
  chooseAttachments: () => ipcRenderer.invoke(CHANNELS.chooseAttachments),
  resolveDroppedAttachments: (files) => ipcRenderer.invoke(
    CHANNELS.resolveDroppedAttachments,
    files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
  ),
  listRuns: () => ipcRenderer.invoke(CHANNELS.listRuns),
  getRun: (runId) => ipcRenderer.invoke(CHANNELS.getRun, runId),
  listSessions: (input) => ipcRenderer.invoke(CHANNELS.listSessions, input),
  openOpenCodeProject: (workspace) => ipcRenderer.invoke(CHANNELS.openOpenCodeProject, { workspace }),
  copyOpenCodeSessionLink: (sessionId) => ipcRenderer.invoke(CHANNELS.copyOpenCodeSessionLink, { sessionId }),
  setContinuous: (input) => ipcRenderer.invoke(CHANNELS.setContinuous, input),
  startRun: (input) => ipcRenderer.invoke(CHANNELS.startRun, input),
  stopRun: (runId) => ipcRenderer.invoke(CHANNELS.stopRun, runId),
  onEvent: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('El listener Desktop debe ser una función.');
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
      if (isDesktopEvent(payload)) listener(payload);
    };
    ipcRenderer.on(CHANNELS.event, handler);
    return () => ipcRenderer.removeListener(CHANNELS.event, handler);
  },
};

contextBridge.exposeInMainWorld('opencodeInfinite', Object.freeze(api));
