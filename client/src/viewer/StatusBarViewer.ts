/**
 * Viewer layer: status bar microphone icon + recording wave animation + transcription feedback.
 * Rendering only — data is handed in by the Controller; no fetch/spawn/business logic (02-STANDARDS §2).
 */
import * as vscode from 'vscode';

/** Wave animation frames (cycled while recording). */
const WAVE_FRAMES = ['▁▃▅▇', '▃▅▇▅', '▅▇▅▃', '▇▅▃▁', '▅▃▁▃', '▃▁▃▅'] as const;
const WAVE_INTERVAL_MS = 200;

export class StatusBarViewer implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private waveTimer: ReturnType<typeof setInterval> | null = null;
  private waveFrame = 0;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
    this.item.command = 'vibefox.toggleRecording';
    this.showIdle();
    this.item.show();
  }

  /** Idle: static microphone. */
  showIdle(): void {
    this.stopTimers();
    this.item.text = '$(mic) VibeFox';
    this.item.tooltip = 'VibeFox:点击或按 Ctrl+Shift+Space 开始语音输入';
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

  /** Processing: spinner. */
  showProcessing(): void {
    this.stopTimers();
    this.item.backgroundColor = undefined;
    this.item.text = '$(loading~spin) 转写中…';
    this.item.tooltip = '正在调用 Whisper 转写';
  }

  /** Brief success/error feedback, then returns to idle. */
  flashResult(kind: 'ok' | 'error', detail: string): void {
    this.stopTimers();
    this.item.backgroundColor =
      kind === 'error' ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    this.item.text = kind === 'ok' ? `$(check) ${detail}` : `$(warning) ${detail}`;
    this.flashTimer = setTimeout(() => this.showIdle(), 2500);
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
