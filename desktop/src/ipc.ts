/**
 * Typed IPC contract between the settings window renderer and the main process.
 * The preload script exposes exactly this surface as `window.vibefox` via contextBridge;
 * main.ts implements the handlers. Keep this file dependency-light: it is imported by
 * the browser bundle too.
 */
import type { DictionaryData, DictionarySource } from '../../client/src/models/UserDictionary';
import type { TranscriptHistoryEntry } from '../../client/src/models/TranscriptHistory';
import type { DesktopConfig } from './config';
import type { UsageStats } from './statsStore';

export interface SettingsState {
  config: DesktopConfig;
  licenseKeyPresent: boolean;
  accessibilityTrusted: boolean;
  platform: NodeJS.Platform;
  history: TranscriptHistoryEntry[];
  stats: UsageStats;
  dictionary: DictionaryData;
  officialEndpoint: string;
  appVersion: string;
  /** Current recording phase, mirrored so the window can render live status on open. */
  phase: 'idle' | 'recording' | 'processing';
}

export interface HotkeyCheckResult {
  ok: boolean;
  reason?: string;
}

export interface ImportResult {
  ok: boolean;
  added: number;
  error?: string;
}

/** The API surface preload.ts exposes as `window.vibefox`. */
export interface VibefoxBridge {
  getState(): Promise<SettingsState>;
  /** Persists a partial config; main re-registers the hotkey / rebuilds the tray as needed. */
  updateConfig(patch: Partial<DesktopConfig>): Promise<SettingsState>;
  setLicenseKey(key: string): Promise<SettingsState>;
  clearLicenseKey(): Promise<SettingsState>;

  dictAddEntry(word: string, aliases: string[], source?: DictionarySource): Promise<SettingsState>;
  dictUpdateEntry(originalWord: string, word: string, aliases: string[]): Promise<SettingsState>;
  dictRemoveEntry(word: string): Promise<SettingsState>;
  dictAddReplacement(from: string, to: string, caseSensitive: boolean): Promise<SettingsState>;
  dictRemoveReplacement(from: string): Promise<SettingsState>;
  dictImport(json: string): Promise<ImportResult>;
  dictExport(): Promise<string>;

  historyClear(): Promise<SettingsState>;
  copyText(text: string): Promise<void>;

  /** Validates an accelerator by test-registering it (current hotkey is restored either way). */
  checkHotkey(accelerator: string): Promise<HotkeyCheckResult>;
  requestAccessibility(): Promise<void>;
  /** Triggers the macOS microphone TCC prompt; resolves with whether access is granted. */
  requestMicrophone(): Promise<boolean>;
  completeOnboarding(): Promise<SettingsState>;
  openConfigFile(): Promise<void>;
  toggleRecording(): Promise<void>;

  /** Fired on recording phase changes and whenever main-side state changes (history, config). */
  onStateEvent(listener: (event: StateEvent) => void): void;
}

export type StateEvent =
  | { kind: 'phase'; phase: SettingsState['phase'] }
  | { kind: 'changed' }
  | { kind: 'delivered'; text: string };

export const IPC_CHANNELS = {
  invoke: 'vibefox:invoke',
  event: 'vibefox:event',
} as const;

/** Method-name → bridge call mapping used by the generic invoke channel. */
export type InvokeMethod = Exclude<keyof VibefoxBridge, 'onStateEvent'>;
