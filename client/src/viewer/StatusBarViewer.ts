/**
 * Viewer layer: status bar microphone icon + recording wave animation + transcription feedback.
 * Rendering only — data is handed in by the Controller; no fetch/spawn/business logic (02-STANDARDS §2).
 */
import * as vscode from 'vscode';

/** Bar glyphs by height (index 0 = quietest). The live meter picks per-cell heights from the level. */
const BAR_GLYPHS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;
/** Number of cells in the live meter. */
const METER_CELLS = 5;
/** Meter refresh cadence — fast enough to feel reactive to the voice. */
const METER_INTERVAL_MS = 110;

/** Session stats rendered after each utterance (data assembled by the Controller). */
export interface SessionStats {
  chars: number;
  segments: number;
  engineLabel: string;
  totalMs: number;
}

/** Human-readable labels for the rewrite modes (shown in tooltip / QuickPick). */
export const REWRITE_MODE_LABELS: Record<string, string> = {
  off: '原样转写',
  clean: '智能清理',
  rewrite: '深度润色',
};

export class StatusBarViewer implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private waveTimer: ReturnType<typeof setInterval> | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  private rewriteModeLabel = '';
  private lastStatsLine = '';

  constructor(private readonly shortcutProvider: () => string) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
    this.item.command = 'vibefox.toggleRecording';
    this.showIdle();
    this.item.show();
  }

  /** Controller pushes the current rewrite mode so the idle tooltip can show it with a switch link. */
  setRewriteMode(mode: string): void {
    this.rewriteModeLabel = REWRITE_MODE_LABELS[mode] ?? mode;
    if (this.waveTimer === null && this.flashTimer === null) {
      this.showIdle();
    }
  }

  /** Idle: static microphone. */
  showIdle(): void {
    this.stopTimers();
    this.item.text = '$(mic) VibeFox';
    const shortcut = this.shortcutProvider();
    const tooltip = new vscode.MarkdownString(
      `VibeFox:点击或按 ${shortcut} 开始语音输入` +
        (this.rewriteModeLabel ? `\n\n改写模式:**${this.rewriteModeLabel}** [切换](command:vibefox.selectRewriteMode)` : '') +
        (this.lastStatsLine ? `\n\n上次转写:${this.lastStatsLine}` : ''),
    );
    tooltip.isTrusted = true;
    this.item.tooltip = tooltip;
    this.item.backgroundColor = undefined;
  }

  /**
   * Recording: red background + LIVE input meter driven by the actual mic level + elapsed seconds.
   * The meter reacts to the user's voice (bars jump when speaking, flatten in silence) — this is
   * the primary "your mic is working and we're hearing you" signal, replacing anxious guessing.
   * `levelProvider` returns 0..1 (0 when VAD is off / no PCM to measure → meter stays flat but the
   * $(record) icon + timer still confirm recording is active).
   */
  showRecording(elapsedSecondsProvider: () => number, maxSeconds: number, levelProvider: () => number): void {
    this.stopTimers();
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    this.item.tooltip = '录音中 —— 波形跟随你的声音跳动即表示麦克风正常;再按一次停止并转写,Esc 取消';
    const render = (): void => {
      this.item.text = `$(record) ${this.meter(levelProvider())} ${elapsedSecondsProvider()}s/${maxSeconds}s`;
    };
    render();
    this.waveTimer = setInterval(render, METER_INTERVAL_MS);
  }

  /**
   * Renders a reactive meter for the current level (0..1). Per-cell jitter makes it read like a
   * moving waveform when there's signal, while a near-zero level renders a calm flat baseline.
   */
  private meter(level: number): string {
    const clamped = Math.max(0, Math.min(1, level));
    // The recorder already noise-gates ambient sound to exactly 0, so a near-zero level means
    // silence → render a dead-flat baseline. Crucially the bars are a PURE function of the level
    // (no Math.random): a steady level renders steady bars, so the meter only ever moves when the
    // actual mic level moves — i.e. when someone is really talking. (The old random jitter made it
    // shimmer non-stop even in silence, which is exactly what made it useless.)
    if (clamped < 0.05) {
      return BAR_GLYPHS[0]!.repeat(METER_CELLS);
    }
    let out = '';
    for (let i = 0; i < METER_CELLS; i++) {
      // Static center-weighted shape: middle cells stand taller than the edges at the same level,
      // giving a waveform silhouette that grows/shrinks with the voice but never twitches on its own.
      const centerBoost = 1 - 0.35 * (Math.abs(i - (METER_CELLS - 1) / 2) / ((METER_CELLS - 1) / 2));
      const h = clamped * centerBoost;
      const idx = Math.max(0, Math.min(BAR_GLYPHS.length - 1, Math.round(h * (BAR_GLYPHS.length - 1))));
      out += BAR_GLYPHS[idx];
    }
    return out;
  }

  /** Processing: spinner (optionally with the running segment count during a VAD session). */
  showProcessing(segmentCount?: number): void {
    this.stopTimers();
    this.item.backgroundColor = undefined;
    this.item.text = segmentCount !== undefined && segmentCount > 0 ? `$(loading~spin) 转写中…(第${segmentCount + 1}段)` : '$(loading~spin) 转写中…';
    this.item.tooltip = '正在转写语音';
  }

  /** Transcription is taking unusually long (engine fallback / slow network) — reassure, don't look frozen. */
  showProcessingSlow(): void {
    this.item.text = '$(loading~spin) 转写中…(网络较慢或引擎切换中)';
    this.item.tooltip = '主引擎响应慢,正在自动切换备用引擎';
  }

  /** Brief success/error feedback, then returns to idle. */
  flashResult(kind: 'ok' | 'error', detail: string): void {
    this.stopTimers();
    this.item.backgroundColor =
      kind === 'error' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.text = kind === 'ok' ? `$(check) ${detail}` : `$(warning) ${detail}`;
    this.flashTimer = setTimeout(() => this.showIdle(), 2500);
  }

  /** Session-end consolidated feedback: "✓ 86字(3段) · Qwen3+Qwen · 1.4s". */
  flashResultWithStats(stats: SessionStats): void {
    const seconds = (stats.totalMs / 1000).toFixed(1);
    const segmentPart = stats.segments > 1 ? `(${stats.segments}段)` : '';
    this.lastStatsLine = `${stats.chars}字${segmentPart} · ${stats.engineLabel} · ${seconds}s`;
    this.flashResult('ok', this.lastStatsLine);
  }

  dispose(): void {
    this.stopTimers();
    this.item.dispose();
  }

  private stopTimers(): void {
    if (this.waveTimer !== null) {
      clearInterval(this.waveTimer);
      this.waveTimer = null;
    }
    if (this.flashTimer !== null) {
      clearTimeout(this.flashTimer);
      this.flashTimer = null;
    }
  }
}
