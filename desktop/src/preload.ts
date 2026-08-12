/**
 * Preload for the settings window: exposes the typed VibefoxBridge as `window.vibefox`.
 * Every method funnels through one invoke channel; the main process dispatches by name.
 */
import { contextBridge, ipcRenderer } from 'electron';

import { IPC_CHANNELS, type InvokeMethod, type StateEvent, type VibefoxBridge } from './ipc';

function call(method: InvokeMethod, ...args: unknown[]): Promise<never> {
  return ipcRenderer.invoke(IPC_CHANNELS.invoke, method, ...args) as Promise<never>;
}

const bridge: VibefoxBridge = {
  getState: () => call('getState'),
  updateConfig: (patch) => call('updateConfig', patch),
  setLicenseKey: (key) => call('setLicenseKey', key),
  clearLicenseKey: () => call('clearLicenseKey'),
  dictAddEntry: (word, aliases, source) => call('dictAddEntry', word, aliases, source),
  dictUpdateEntry: (originalWord, word, aliases) => call('dictUpdateEntry', originalWord, word, aliases),
  dictRemoveEntry: (word) => call('dictRemoveEntry', word),
  dictAddReplacement: (from, to, caseSensitive) => call('dictAddReplacement', from, to, caseSensitive),
  dictRemoveReplacement: (from) => call('dictRemoveReplacement', from),
  dictImport: (json) => call('dictImport', json),
  dictExport: () => call('dictExport'),
  historyClear: () => call('historyClear'),
  copyText: (text) => call('copyText', text),
  checkHotkey: (accelerator) => call('checkHotkey', accelerator),
  requestAccessibility: () => call('requestAccessibility'),
  requestMicrophone: () => call('requestMicrophone'),
  completeOnboarding: () => call('completeOnboarding'),
  openConfigFile: () => call('openConfigFile'),
  toggleRecording: () => call('toggleRecording'),
  onStateEvent: (listener) => {
    ipcRenderer.on(IPC_CHANNELS.event, (_event, payload: StateEvent) => listener(payload));
  },
};

contextBridge.exposeInMainWorld('vibefox', bridge);
