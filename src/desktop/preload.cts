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
  listModels: 'models:list',
  openOpenCodeProject: 'sessions:open-project',
  copyOpenCodeSessionLink: 'sessions:copy-internal-link',
  copyRunDeepLink: 'runs:copy-deep-link',
  copySessionDeepLink: 'sessions:copy-deep-link',
  getSessionContext: 'sessions:context',
  setContinuous: 'sessions:set-continuous',
  startRun: 'runs:start',
  resumeRun: 'runs:resume',
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
  listModels: (input) => ipcRenderer.invoke(CHANNELS.listModels, input),
  openOpenCodeProject: (workspace) => ipcRenderer.invoke(CHANNELS.openOpenCodeProject, { workspace }),
  copyOpenCodeSessionLink: (sessionId) => ipcRenderer.invoke(CHANNELS.copyOpenCodeSessionLink, { sessionId }),
  copyRunDeepLink: (runId) => ipcRenderer.invoke(CHANNELS.copyRunDeepLink, runId),
  copySessionDeepLink: (sessionId) => ipcRenderer.invoke(CHANNELS.copySessionDeepLink, { sessionId }),
  getSessionContext: (input) => ipcRenderer.invoke(CHANNELS.getSessionContext, input),
  setContinuous: (input) => ipcRenderer.invoke(CHANNELS.setContinuous, input),
  startRun: (input) => ipcRenderer.invoke(CHANNELS.startRun, input),
  resumeRun: (input) => ipcRenderer.invoke(CHANNELS.resumeRun, input),
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
