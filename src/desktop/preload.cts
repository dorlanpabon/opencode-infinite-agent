import type { DesktopApi, DesktopEvent } from './contracts.js';

const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

const CHANNELS = Object.freeze({
  systemInfo: 'system:info',
  doctor: 'system:doctor',
  chooseWorkspace: 'workspace:choose',
  chooseBinary: 'binary:choose',
  listRuns: 'runs:list',
  getRun: 'runs:get',
  startRun: 'runs:start',
  stopRun: 'runs:stop',
  event: 'runs:event',
});

const EVENT_TYPES = new Set(['run-changed', 'operation-finished', 'operation-error', 'log']);

function isDesktopEvent(value: unknown): value is DesktopEvent {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && EVENT_TYPES.has(String((value as { type?: unknown }).type));
}

const api: DesktopApi = {
  systemInfo: () => ipcRenderer.invoke(CHANNELS.systemInfo),
  doctor: (workspace, binary, attach) => ipcRenderer.invoke(CHANNELS.doctor, { workspace, binary, attach }),
  chooseWorkspace: () => ipcRenderer.invoke(CHANNELS.chooseWorkspace),
  chooseBinary: () => ipcRenderer.invoke(CHANNELS.chooseBinary),
  listRuns: () => ipcRenderer.invoke(CHANNELS.listRuns),
  getRun: (runId) => ipcRenderer.invoke(CHANNELS.getRun, runId),
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
