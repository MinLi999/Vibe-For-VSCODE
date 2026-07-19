/**
 * Desktop config: a plain JSON file in Electron's userData dir the user can edit directly.
 * Mirrors the vibefox.* extension settings that make sense outside VS Code. No secrets here —
 * the license key lives in the OS keychain (see licenseStore.ts).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ChineseVariant, RegionPreference, RewriteMode } from '../../client/src/services/CloudflareApiService';

export interface DesktopConfig {
  /** Cloudflare Worker base URL (no trailing slash). */
  endpoint: string;
  /** Electron accelerator for the global record toggle. Must avoid macOS SYSTEM shortcuts, which
   * silently swallow the key before Electron sees it (globalShortcut.register still returns true!).
   * Also avoids Ctrl+Shift+Space (the VS Code extension's binding). See RESERVED_HOTKEYS. */
  hotkey: string;
  language: string;
  maxRecordSeconds: number;
  ffmpegPath: string;
  audioDevice: string;
  vadEnabled: boolean;
  vadSilenceMs: number;
  vadMinDurationMs: number;
  vadSilenceThreshold: number;
  vadAdaptiveThreshold: boolean;
  rewriteMode: RewriteMode;
  chineseVariant: ChineseVariant;
  dashscopeRegion: RegionPreference;
  /** Restore the previous clipboard text ~1s after pasting the transcription. */
  restoreClipboard: boolean;
}

/**
 * Accelerators macOS reserves as SYSTEM shortcuts (or that collide with the VS Code extension).
 * globalShortcut.register returns true for these, but the OS grabs the key first so the handler
 * never fires — the classic "hotkey does nothing" trap. Any stored value here is auto-migrated to
 * the current default. Space + Ctrl/Cmd/Opt combos are input-source / Spotlight / emoji switchers.
 */
const RESERVED_HOTKEYS = new Set<string>([
  'Control+Space',           // macOS: select previous input source
  'Control+Alt+Space',       // macOS: select next input source (the original default — reserved!)
  'Command+Space',           // macOS: Spotlight
  'Command+Alt+Space',       // macOS: Finder search
  'Control+Command+Space',   // macOS: emoji & symbols picker
  'Control+Shift+Space',     // VS Code extension's own record hotkey — don't fight it
]);

export const DEFAULT_CONFIG: DesktopConfig = {
  endpoint: 'https://vibe-voice-worker.presley-us.workers.dev',
  hotkey: 'Command+Alt+Z',
  language: 'zh',
  maxRecordSeconds: 120,
  ffmpegPath: '',
  audioDevice: '',
  vadEnabled: true,
  vadSilenceMs: 1200,
  vadMinDurationMs: 3000,
  vadSilenceThreshold: 350,
  vadAdaptiveThreshold: true,
  rewriteMode: 'clean',
  chineseVariant: 'simplified-cn',
  dashscopeRegion: 'auto',
  restoreClipboard: true,
};

export function configFilePath(userDataDir: string): string {
  return path.join(userDataDir, 'config.json');
}

/** Loads config.json, filling gaps with defaults; writes the merged file back on first run so
 * the user always has a complete, editable file to tweak. */
export function loadConfig(userDataDir: string): DesktopConfig {
  const file = configFilePath(userDataDir);
  let stored: Partial<DesktopConfig> = {};
  try {
    stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DesktopConfig>;
  } catch {
    /* Missing or invalid file — fall through to defaults. */
  }
  const merged: DesktopConfig = { ...DEFAULT_CONFIG, ...stored };
  merged.maxRecordSeconds = Math.min(600, Math.max(3, merged.maxRecordSeconds));
  // Auto-heal a stored hotkey that the OS would silently swallow (e.g. the original
  // Control+Alt+Space default, which macOS reserves for input-source switching).
  if (RESERVED_HOTKEYS.has(merged.hotkey)) {
    merged.hotkey = DEFAULT_CONFIG.hotkey;
  }
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  } catch {
    /* Read-only disk is not fatal; run with the in-memory config. */
  }
  return merged;
}

export function saveConfig(userDataDir: string, config: DesktopConfig): void {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(configFilePath(userDataDir), JSON.stringify(config, null, 2) + '\n', 'utf8');
  } catch {
    /* Best effort — the in-memory config still applies for this session. */
  }
}
