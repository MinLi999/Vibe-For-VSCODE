/**
 * VibeFox Desktop — menu-bar voice input for the Claude desktop app (and any focused text field).
 * Press the global hotkey, speak, press again: the transcription (same Cloudflare Worker
 * pipeline as the VS Code extension) is pasted into the frontmost app at the caret.
 *
 * Reuses the extension's vscode-free service layer verbatim:
 *   - AudioRecorderService (ffmpeg capture + VAD + MP3 compression)
 *   - CloudflareApiService (protocol v2, typed errors)
 */
import { app, Menu, Notification, Tray, clipboard, globalShortcut, nativeImage, shell, systemPreferences } from 'electron';
import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { dedupeAgainstSession } from '../../client/src/models/TranscriptDedupe';
import { TranscriptHistory } from '../../client/src/models/TranscriptHistory';
import { frontmostAppCategory } from './frontmostApp';
import { AudioRecorderService, FfmpegNotFoundError } from '../../client/src/services/AudioRecorderService';
import { ApiError, CloudflareApiService } from '../../client/src/services/CloudflareApiService';
import type { AppCategory, ChineseVariant, RegionPreference, RewriteMode } from '../../client/src/services/CloudflareApiService';
import { DesktopConfig, configFilePath, loadConfig, saveConfig } from './config';
import { clearLicenseKey, getLicenseKey, setLicenseKey } from './licenseStore';
import { pasteIntoFrontmostApp } from './paste';

type Phase = 'idle' | 'recording' | 'processing';

const LEVEL_BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇'];

class DesktopApp {
  private readonly recorder = new AudioRecorderService();
  private readonly api = new CloudflareApiService();
  private tray: Tray | null = null;
  private config: DesktopConfig;
  private phase: Phase = 'idle';

  // Per-recording session state (mirrors the extension controller's session bookkeeping).
  private mp3Chunks: Buffer[] = []; // Non-VAD mode: the raw MP3 stream.
  private segmentQueue: Promise<void> = Promise.resolve(); // Keeps VAD segments pasted in spoken order.
  private sessionTranscript = '';
  private sessionChars = 0;
  private sessionErrors: string[] = [];
  private maxTimer: NodeJS.Timeout | null = null;
  private levelTimer: NodeJS.Timeout | null = null;
  private flashTimer: NodeJS.Timeout | null = null;
  private micAccessAsked = false;
  private pasteHintShown = false; // Gates the "no accessibility → on clipboard" hint to once per session.
  /** Local-only transcription history (history.json next to config.json; never leaves the machine). */
  private history: TranscriptHistory;
  /** Category of the app that was frontmost when recording started (= the paste target). */
  private sessionAppCategory: AppCategory | undefined;

  constructor(private readonly userDataDir: string) {
    this.config = loadConfig(userDataDir);
    this.history = new TranscriptHistory(this.loadHistoryFile());
  }

  private historyFilePath(): string {
    return path.join(this.userDataDir, 'history.json');
  }

  private loadHistoryFile(): unknown {
    try {
      return JSON.parse(fs.readFileSync(this.historyFilePath(), 'utf8'));
    } catch {
      return []; // Missing or corrupted file — TranscriptHistory sanitizes anyway.
    }
  }

  /** Recorded BEFORE the paste so text survives even when the frontmost app rejects it. */
  private recordHistory(text: string): void {
    this.history.add(text);
    this.recordHistoryFileOnly();
    this.rebuildMenu();
  }

  private recordHistoryFileOnly(): void {
    try {
      fs.writeFileSync(this.historyFilePath(), JSON.stringify(this.history.toJSON(), null, 2));
    } catch {
      // Persistence is best-effort; the in-memory history still serves the tray menu.
    }
  }

  start(): void {
    // Pure menu-bar app: no dock icon, no windows.
    app.dock?.hide();
    // A real template image (not createEmpty) — an empty tray image renders as a zero-width,
    // effectively invisible/unclickable slot on macOS, which is why the menu-bar icon "wasn't there".
    this.tray = new Tray(this.trayIcon());
    this.tray.setIgnoreDoubleClickEvents(true);
    this.setTrayTitle('');
    this.rebuildMenu();
    this.registerHotkey();
    if (!this.accessibilityTrusted()) {
      // Nudge once so the user knows where to grant the permission that makes auto-paste work.
      this.notify('VibeFox', `热键 ${this.config.hotkey} 已就绪。自动粘贴需要辅助功能权限:点菜单栏 🦊 →「授予辅助功能权限…」。`);
    }
  }

  shutdown(): void {
    globalShortcut.unregisterAll();
    void this.recorder.cancel();
  }

  // ---- Tray / menu (view-ish layer, kept dumb) ----

  /** Loads the bundled monochrome menu-bar icon as a macOS template image (adapts to light/dark). */
  private trayIcon(): Electron.NativeImage {
    const file = path.join(app.getAppPath(), 'assets', 'trayTemplate.png');
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) {
      img.setTemplateImage(true);
      return img;
    }
    // Fallback: a tiny inline dot so the tray is still visible if the asset is missing.
    const dot = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAP0lEQVR4nGNgGAWjYBSMglEwCkbBKBgFo2AUjIJRMApGwSgYBaNgFIyCUTAKRsEoGAWjYBSMglEwCkbBcAAAF9QAAcTq2AAAAAAASUVORK5CYII=',
    );
    return dot;
  }

  private setTrayTitle(title: string): void {
    // A leading space separates the title text from the icon when there IS a title.
    this.tray?.setTitle(title ? ` ${title}` : '');
    this.tray?.setToolTip(`VibeFox — ${this.config.hotkey} 开始/停止录音`);
  }

  private rebuildMenu(): void {
    const radio = <T extends string>(
      current: T,
      value: T,
      label: string,
      apply: (v: T) => void,
    ): Electron.MenuItemConstructorOptions => ({
      label,
      type: 'radio',
      checked: current === value,
      click: () => {
        apply(value);
        saveConfig(this.userDataDir, this.config);
        this.rebuildMenu();
      },
    });

    const menu = Menu.buildFromTemplate([
      { label: `热键:${this.config.hotkey}`, enabled: false },
      {
        label: this.phase === 'recording' ? '停止录音并转写' : '开始录音',
        enabled: this.phase !== 'processing',
        click: () => void this.toggleRecording(),
      },
      { label: '取消录音', enabled: this.phase === 'recording', click: () => void this.cancelRecording() },
      {
        label: '转写历史(仅本机)',
        submenu: [
          ...(this.history.size === 0
            ? [{ label: '(空)', enabled: false } as Electron.MenuItemConstructorOptions]
            : this.history.list().slice(0, 10).map((e): Electron.MenuItemConstructorOptions => ({
                label: e.text.length > 40 ? `${e.text.slice(0, 40)}…` : e.text,
                toolTip: `${new Date(e.at).toLocaleString()} — 点击复制全文`,
                click: () => {
                  clipboard.writeText(e.text);
                  this.notify('VibeFox', '已复制到剪贴板。');
                },
              }))),
          { type: 'separator' },
          {
            label: '清空历史',
            enabled: this.history.size > 0,
            click: () => {
              this.history.clear();
              this.recordHistoryFileOnly();
              this.rebuildMenu();
            },
          },
        ],
      },
      { type: 'separator' },
      {
        label: '改写模式',
        submenu: (['off', 'clean', 'rewrite'] as RewriteMode[]).map((m) =>
          radio(this.config.rewriteMode, m, { off: '原样转写 off', clean: '智能清理 clean(推荐)', rewrite: '深度润色 rewrite' }[m], (v) => {
            this.config.rewriteMode = v;
          }),
        ),
      },
      {
        label: '中文变体',
        submenu: (
          [
            ['simplified-cn', '简体 · 大陆'],
            ['simplified-sg-my', '简体 · 新马'],
            ['traditional-tw', '繁體 · 台灣'],
            ['traditional-hk-mo', '繁體 · 港澳'],
          ] as [ChineseVariant, string][]
        ).map(([v, label]) =>
          radio(this.config.chineseVariant, v, label, (val) => {
            this.config.chineseVariant = val;
          }),
        ),
      },
      {
        label: '转写区域',
        submenu: (
          [
            ['auto', '自动(按大洲就近)'],
            ['apac', '新加坡区'],
            ['us', '美国区'],
          ] as [RegionPreference, string][]
        ).map(([v, label]) =>
          radio(this.config.dashscopeRegion, v, label, (val) => {
            this.config.dashscopeRegion = val;
          }),
        ),
      },
      { type: 'separator' },
      { label: '设置 License Key…', click: () => void this.promptLicenseKey() },
      { label: '清除 License Key', click: () => void clearLicenseKey(this.userDataDir) },
      ...(process.platform === 'darwin'
        ? [{ label: this.accessibilityTrusted() ? '辅助功能:已授权 ✓' : '授予辅助功能权限(自动粘贴需要)…', click: () => this.requestAccessibility() }]
        : []),
      {
        label: '打开配置文件',
        click: () => {
          void shell.openPath(configFilePath(this.userDataDir));
        },
      },
      { type: 'separator' },
      { label: '退出 VibeFox', click: () => app.quit() },
    ]);
    this.tray?.setContextMenu(menu);
  }

  private notify(title: string, body: string): void {
    new Notification({ title, body }).show();
  }

  /** Whether this process is a trusted Accessibility client (no prompt). Non-macOS → always true. */
  private accessibilityTrusted(): boolean {
    return process.platform !== 'darwin' || systemPreferences.isTrustedAccessibilityClient(false);
  }

  /**
   * The synthetic ⌘V paste needs Accessibility permission, but an UNPACKAGED Electron only shows
   * up in System Settings → Accessibility AFTER it first calls this API. `isTrustedAccessibilityClient(true)`
   * both registers this process in that list and pops the system prompt — so this menu item is what
   * makes "Electron" findable there in the first place. Also deep-links to the pane as a backup.
   */
  private requestAccessibility(): void {
    if (process.platform !== 'darwin') {
      return;
    }
    const trusted = systemPreferences.isTrustedAccessibilityClient(true); // prompt + register in TCC list
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    if (trusted) {
      this.notify('VibeFox', '辅助功能权限已就绪,自动粘贴可用。');
    } else {
      this.notify(
        'VibeFox',
        '已在「辅助功能」列表中加入 Electron 并打开设置面板。请勾选 Electron(开关打开),然后回到 Claude App 再按热键。',
      );
    }
    this.rebuildMenu(); // Refresh the checkmark label.
  }

  // ---- Hotkey ----

  private registerHotkey(): void {
    const ok = globalShortcut.register(this.config.hotkey, () => void this.toggleRecording());
    if (!ok) {
      this.notify('VibeFox', `全局热键 ${this.config.hotkey} 注册失败(可能被其他应用占用)。请在配置文件中修改 hotkey 后重启。`);
    }
  }

  // ---- Recording session (controller layer) ----

  private async toggleRecording(): Promise<void> {
    if (this.phase === 'recording') {
      await this.stopAndFinish();
      return;
    }
    if (this.phase === 'processing') {
      return; // Ignore presses while the tail of the previous session is still transcribing.
    }
    await this.startRecording();
  }

  private async startRecording(): Promise<void> {
    const licenseKey = await getLicenseKey(this.userDataDir);
    if (licenseKey === null) {
      this.notify('VibeFox', '还没有设置 License Key — 点击菜单栏图标 →「设置 License Key…」');
      return;
    }
    if (process.platform === 'darwin' && !this.micAccessAsked) {
      this.micAccessAsked = true;
      // Triggers the TCC prompt attributed to this app; the spawned ffmpeg child inherits it.
      await systemPreferences.askForMediaAccess('microphone').catch(() => undefined);
    }

    this.mp3Chunks = [];
    this.sessionTranscript = '';
    this.sessionChars = 0;
    this.sessionErrors = [];
    this.pasteHintShown = false;
    // The app under the cursor when the hotkey fires is the paste target — capture its
    // category (fire-and-forget) so the rewrite stage can adapt tone. Failure → no hint.
    this.sessionAppCategory = undefined;
    void frontmostAppCategory().then((category) => {
      this.sessionAppCategory = category;
    });

    try {
      await this.recorder.start(
        {
          ffmpegPath: this.config.ffmpegPath,
          audioDevice: this.config.audioDevice,
          maxSeconds: this.config.maxRecordSeconds,
          vadEnabled: this.config.vadEnabled,
          vadSilenceMs: this.config.vadSilenceMs,
          vadMinDurationMs: this.config.vadMinDurationMs,
          vadSilenceThreshold: this.config.vadSilenceThreshold,
          vadAdaptiveThreshold: this.config.vadAdaptiveThreshold,
          onSegment: (segmentMp3) => this.enqueueSegment(segmentMp3, licenseKey),
          onSegmentError: (error) => this.sessionErrors.push(error.message),
        },
        (chunk) => {
          this.mp3Chunks.push(chunk); // Only fires in non-VAD mode (plain MP3 stream).
        },
        (error) => {
          this.notify('VibeFox 录音错误', error.message);
          void this.cancelRecording();
        },
      );
    } catch (err) {
      if (err instanceof FfmpegNotFoundError) {
        this.notify('VibeFox', `未找到 ffmpeg。请在终端执行:${err.installCommand},或在配置文件里设置 ffmpegPath。`);
      } else {
        this.notify('VibeFox 录音启动失败', err instanceof Error ? err.message : String(err));
      }
      return;
    }

    this.phase = 'recording';
    this.rebuildMenu();
    this.maxTimer = setTimeout(() => void this.stopAndFinish(), this.config.maxRecordSeconds * 1000);
    this.levelTimer = setInterval(() => {
      const idx = Math.min(LEVEL_BARS.length - 1, Math.floor(this.recorder.inputLevel * LEVEL_BARS.length));
      this.setTrayTitle(`🔴${LEVEL_BARS[idx] ?? '▁'}`);
    }, 250);
    this.setTrayTitle('🔴▁');
  }

  private clearRecordingTimers(): void {
    if (this.maxTimer !== null) {
      clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
    if (this.levelTimer !== null) {
      clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
  }

  private async cancelRecording(): Promise<void> {
    this.clearRecordingTimers();
    await this.recorder.cancel();
    this.phase = 'idle';
    this.rebuildMenu();
    this.setTrayTitle('');
  }

  private async stopAndFinish(): Promise<void> {
    if (this.phase !== 'recording') {
      return;
    }
    this.clearRecordingTimers();
    this.phase = 'processing';
    this.rebuildMenu();
    this.setTrayTitle('⏳');

    const licenseKey = await getLicenseKey(this.userDataDir);
    const trailingMp3 = await this.recorder.stop();
    if (licenseKey !== null) {
      if (trailingMp3 !== null) {
        this.enqueueSegment(trailingMp3, licenseKey); // VAD mode: compressed trailing PCM.
      } else if (!this.config.vadEnabled && this.mp3Chunks.length > 0) {
        this.enqueueSegment(Buffer.concat(this.mp3Chunks), licenseKey);
      }
    }
    this.mp3Chunks = [];

    await this.segmentQueue; // Wait for every in-flight segment to paste before going idle.
    this.finishSession();
  }

  private finishSession(): void {
    this.phase = 'idle';
    this.rebuildMenu();
    if (this.sessionErrors.length > 0) {
      const unique = [...new Set(this.sessionErrors)];
      this.notify('VibeFox', `本次录音有 ${this.sessionErrors.length} 段转写失败 —— ${unique[0]}`);
    }
    this.setTrayTitle(this.sessionChars > 0 ? `✓${this.sessionChars}` : '');
    if (this.flashTimer !== null) {
      clearTimeout(this.flashTimer);
    }
    this.flashTimer = setTimeout(() => this.setTrayTitle(''), 3000);
  }

  /** Serializes segment transcription+paste so multi-segment sessions land in spoken order. */
  private enqueueSegment(mp3: Buffer, licenseKey: string): void {
    this.segmentQueue = this.segmentQueue
      .then(() => this.processSegment(mp3, licenseKey))
      .catch(() => undefined);
  }

  /**
   * Delivers transcribed text to the frontmost app. The synthetic ⌘V needs Accessibility
   * permission; without it macOS silently drops the keystroke, so rather than paste-into-the-void
   * (and worse, restore the clipboard 1s later, eating the text), we detect the missing grant,
   * leave the text on the clipboard for a manual ⌘V, and tell the user exactly how to enable
   * auto-paste. One notification per recording session.
   */
  private async deliverText(text: string): Promise<void> {
    // ALWAYS attempt the paste — never gate it on isTrustedAccessibilityClient(): that check reads
    // a per-process cached value that stays false until the app is relaunched, even after the user
    // grants the permission, so gating would suppress a keystroke that would in fact succeed.
    // Only restore the clipboard when we believe we're trusted (a failed paste + restore would eat
    // the text 1s later); when untrusted, leave the transcription on the clipboard for a manual ⌘V.
    const trusted = this.accessibilityTrusted();
    await pasteIntoFrontmostApp(text, trusted && this.config.restoreClipboard);
    if (!trusted && !this.pasteHintShown) {
      this.pasteHintShown = true;
      this.notify(
        'VibeFox',
        '转写已复制到剪贴板。若没自动粘进 Claude:菜单栏图标 →「授予辅助功能权限…」勾选 VibeFox,然后【退出并重开 VibeFox】(权限需重启才生效)。在此之前可直接 ⌘V。',
      );
    }
  }

  private async processSegment(mp3: Buffer, licenseKey: string): Promise<void> {
    try {
      const result = await this.api.transcribe(this.config.endpoint, licenseKey, {
        audio: mp3.toString('base64'),
        language: this.config.language,
        // No IDE workspace to mine outside VS Code, so the correction glossary is the
        // user-maintained config.vocabulary instead — this is what lets the rewrite stage
        // fix code identifiers / camelCase (e.g. "use effect" -> "useEffect").
        keywords: this.config.vocabulary,
        projectContext: this.config.projectContext.trim().length > 0 ? this.config.projectContext : undefined,
        rewriteMode: this.config.rewriteMode,
        chineseVariant: this.config.chineseVariant,
        regionPreference: this.config.dashscopeRegion,
        capturePeak: Math.round(this.recorder.peakAmplitude),
        appCategory: this.sessionAppCategory,
      });
      const finalText = dedupeAgainstSession(this.sessionTranscript, result.finalText);
      if (finalText.trim().length === 0) {
        return;
      }
      this.sessionTranscript = (this.sessionTranscript + ' ' + finalText).trim();
      this.sessionChars += finalText.length;
      this.recordHistory(finalText);
      await this.deliverText(finalText);
    } catch (err) {
      if (isNoSpeechError(err)) {
        return; // Inter-sentence silence gaps legitimately transcribe to nothing.
      }
      if (err instanceof ApiError && err.kind === 'unauthorized') {
        this.notify('VibeFox', 'License Key 无效或已失效,请重新设置。');
        return;
      }
      this.sessionErrors.push(err instanceof Error ? err.message : String(err));
    }
  }

  // ---- License key prompt (native AppleScript dialog on macOS; notification elsewhere) ----

  private async promptLicenseKey(): Promise<void> {
    if (process.platform !== 'darwin') {
      this.notify('VibeFox', `请将 License Key 写入 ${this.userDataDir}/license.key 文件。`);
      return;
    }
    const script =
      'text returned of (display dialog "输入 VibeFox License Key" default answer "" with hidden answer with title "VibeFox")';
    const key = await new Promise<string | null>((resolve) => {
      exec(`osascript -e '${script}'`, (error, stdout) => {
        resolve(error ? null : stdout.trim()); // Non-zero exit = user pressed Cancel.
      });
    });
    if (key !== null && key.length > 0) {
      await setLicenseKey(this.userDataDir, key);
      this.notify('VibeFox', 'License Key 已保存到系统钥匙串。');
    }
  }
}

/** A "no speech" 502 is a normal VAD outcome (silence between sentences), not a failure. */
function isNoSpeechError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('no text') || msg.includes('non-speech') || msg.includes('silent') || msg.includes('empty') || msg.includes('502')
  );
}

// ---- App bootstrap ----

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let desktopApp: DesktopApp | null = null;
  void app.whenReady().then(() => {
    desktopApp = new DesktopApp(app.getPath('userData'));
    desktopApp.start();
  });
  app.on('will-quit', () => {
    desktopApp?.shutdown();
  });
  // Menu-bar app: never quit just because there are no windows (there never are any).
  app.on('window-all-closed', () => {
    /* keep running */
  });
}
