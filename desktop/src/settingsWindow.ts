/**
 * Settings window lifecycle + IPC plumbing. Deliberately dumb: every bridge method is
 * delegated to the handlers object main.ts provides (the controller); this module only
 * owns the BrowserWindow and the generic invoke/event channels.
 */
import { BrowserWindow, app, ipcMain } from 'electron';
import * as path from 'node:path';

import { IPC_CHANNELS, type InvokeMethod, type StateEvent, type VibefoxBridge } from './ipc';

/** Main-process implementations of the renderer bridge (same signatures). */
export type ServerHandlers = {
  [M in InvokeMethod]: (...args: Parameters<VibefoxBridge[M]>) => ReturnType<VibefoxBridge[M]>;
};

export class SettingsWindow {
  private window: BrowserWindow | null = null;
  private ipcRegistered = false;

  constructor(private readonly handlers: ServerHandlers) {}

  show(onboarding = false): void {
    if (this.window !== null && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      app.focus({ steal: true });
      return;
    }
    this.registerIpc();
    this.window = new BrowserWindow({
      width: 900,
      height: 660,
      minWidth: 720,
      minHeight: 520,
      title: 'VibeFox',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.window.once('ready-to-show', () => {
      this.window?.show();
      app.focus({ steal: true });
    });
    this.window.on('closed', () => {
      this.window = null;
    });
    void this.window.loadFile(path.join(__dirname, 'settings.html'), onboarding ? { query: { onboarding: '1' } } : undefined);
  }

  broadcast(event: StateEvent): void {
    if (this.window !== null && !this.window.isDestroyed()) {
      this.window.webContents.send(IPC_CHANNELS.event, event);
    }
  }

  dispose(): void {
    this.window?.destroy();
    this.window = null;
  }

  private registerIpc(): void {
    if (this.ipcRegistered) {
      return;
    }
    this.ipcRegistered = true;
    ipcMain.handle(IPC_CHANNELS.invoke, (_event, method: string, ...args: unknown[]) => {
      const handler = this.handlers[method as InvokeMethod];
      if (typeof handler !== 'function') {
        throw new Error(`Unknown bridge method: ${method}`);
      }
      return (handler as (...a: unknown[]) => Promise<unknown>)(...args);
    });
  }
}
