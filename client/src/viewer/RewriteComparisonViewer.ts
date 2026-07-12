/**
 * Viewer layer: temporary Haiku-vs-Qwen rewrite comparison log. Dumps each utterance's raw
 * transcript plus both rewrite outputs to a dedicated Output Channel so the user can read
 * side-by-side over several days of real usage and decide which engine to keep as default.
 * Rendering only — no business logic, no fetch/spawn (02-STANDARDS §2).
 */
import * as vscode from 'vscode';

export interface ComparisonEntry {
  rawText: string;
  primaryEngine: string;
  primaryText: string;
  primaryMs: number;
  qwenText?: string;
  qwenMs?: number;
  qwenError?: string;
}

export class RewriteComparisonViewer implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;

  constructor() {
    this.channel = vscode.window.createOutputChannel('VibeFox: Rewrite Comparison (Haiku vs Qwen)');
  }

  log(entry: ComparisonEntry): void {
    const time = new Date().toLocaleTimeString();
    this.channel.appendLine(`──── ${time} ────`);
    this.channel.appendLine(`原始转写: ${entry.rawText}`);
    this.channel.appendLine(`${entry.primaryEngine}(${entry.primaryMs}ms): ${entry.primaryText}`);
    if (entry.qwenError) {
      this.channel.appendLine(`Qwen-Plus: 出错(${entry.qwenError})`);
    } else if (entry.qwenText !== undefined) {
      this.channel.appendLine(`Qwen-Plus(${entry.qwenMs}ms): ${entry.qwenText}`);
    }
    this.channel.appendLine('');
  }

  dispose(): void {
    this.channel.dispose();
  }
}
