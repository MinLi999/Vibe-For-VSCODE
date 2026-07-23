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
  /** "auto" (default; quality-tier ASR self-detects — best for zh/en code-switching) or ISO-639-1. */
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
  /**
   * Experimental streaming transcription (pro tier): utterances transcribe while you speak
   * and paste as they finalize. Needs an Electron runtime with a global WebSocket (Node >= 22);
   * silently falls back to the batch path otherwise or on any stream failure.
   */
  streamingMode: boolean;
  /**
   * Correction glossary fed to the rewrite stage. List the product names, tech terms and
   * camelCase identifiers you dictate that the ASR mis-hears or mis-cases (e.g. spoken
   * "use effect" is restored to "useEffect"). The rewrite prompt only fixes casing/spelling
   * for words that appear here — words outside the list are left as the ASR heard them.
   * The server keeps at most 40 entries, 64 chars each; add your own freely.
   */
  vocabulary: string[];
  /**
   * Free-form background handed to the rewrite stage to bias term understanding (never
   * echoed into the output). Seeded with a generic "programmer dictating code" framing so
   * it helps across projects; replace it with a paragraph about your own codebase if you
   * mostly dictate for one project. Server caps it at 8000 chars.
   */
  projectContext: string;
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

/**
 * The officially hosted Worker (paid convenience service). Self-hosters: deploy server/ with
 * wrangler and point `endpoint` in config.json at your own Worker URL — see docs/SELF_HOSTING.md.
 */
export const OFFICIAL_HOSTED_ENDPOINT = 'https://vibe-voice-worker.presley-us.workers.dev';

export const DEFAULT_CONFIG: DesktopConfig = {
  endpoint: OFFICIAL_HOSTED_ENDPOINT,
  hotkey: 'Command+Alt+Z',
  language: 'auto',
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
  streamingMode: false,
  // Seeded from a scan of this codebase plus common dev proper nouns most prone to ASR
  // mis-hearing. Kept under the server's 40-entry cap. Users edit config.json to tune.
  vocabulary: [
    // AI / product / infra proper nouns
    'Claude Code',
    'Claude',
    'Anthropic',
    'Cloudflare',
    'Cloudflare Workers',
    'DashScope',
    'Qwen',
    'VibeFox',
    'GitHub',
    'Vercel',
    'Supabase',
    // Languages / frameworks / tooling (tech stacks)
    'TypeScript',
    'JavaScript',
    'Python',
    'Node.js',
    'React',
    'Next.js',
    'Vite',
    'Tailwind CSS',
    'Electron',
    'Docker',
    'PostgreSQL',
    'Redis',
    // Common dictated dev nouns (casing/spelling fixed by the rewrite stage)
    'model',
    'JSON',
    'Markdown',
    'blog',
    'API',
    'key',
    'project',
    'content',
    'template',
    'dashboard',
    'agent',
    'code',
    'prompt',
    'token',
    'webhook',
    'endpoint',
    'npm',
  ],
  projectContext:
    '用户是程序员,正在用语音向 AI 编程助手(如 Claude Code)口述编程指令。' +
    '内容为中英混杂的技术表达,包含大量代码标识符、函数名、文件名、命令行、产品与技术专有名词。',
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
  // Auto-migrate the original 'zh' default to 'auto' (defaults get materialized into
  // config.json on first run, so a default change alone never reaches existing installs).
  // 'auto' lets Qwen3-ASR self-detect — the official recommendation for mixed zh/en audio;
  // the server still locks the Whisper fallback to 'zh', so nothing is lost by migrating.
  if (merged.language === 'zh') {
    merged.language = 'auto';
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
