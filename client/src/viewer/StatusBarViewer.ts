/**
 * Viewer layer: status bar microphone icon + recording wave animation + transcription feedback.
 * Rendering only — data is handed in by the Controller; no fetch/spawn/business logic (02-STANDARDS §2).
 */
import * as vscode from 'vscode';

/** Wave animation frames (cycled while recording). */
const WAVE_FRAMES = ['▁▃▅▇', '▃▅▇▅', '▅▇▅▃', '▇▅▃▁', '▅▃▁▃', '▃▁▃▅'] as const;
const WAVE_INTERVAL_MS = 200;

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
  private waveFrame = 0;
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

  /** Recording: red background + wave animation + elapsed seconds (Controller supplies elapsed per frame). */
  showRecording(elapsedSecondsProvider: () => number, maxSeconds: number): void {
    this.stopTimers();
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    this.item.tooltip = '录音中 —— 再按一次停止并转写,Esc 取消';
    const render = (): void => {
      const frame = WAVE_FRAMES[this.waveFrame % WAVE_FRAMES.length];
      this.waveFrame += 1;
      this.item.text = `$(record) ${frame} ${elapsedSecondsProvider()}s/${maxSeconds}s`;
    };
    render();
    this.waveTimer = setInterval(render, WAVE_INTERVAL_MS);
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
