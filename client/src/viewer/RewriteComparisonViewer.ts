/**
 * Viewer layer: rewrite-engine comparison log. Dumps each utterance's raw transcript plus the
 * primary engine's output and the shadow (alternative) engine's output to a dedicated Output
 * Channel so the user can read side-by-side over several days of real usage and decide which
 * engine to keep as default. As of the Qwen-Plus switchover the primary is Qwen-Plus and the
 * shadow is Haiku, but this viewer renders whatever engine names it is handed.
 * Rendering only — no business logic, no fetch/spawn (02-STANDARDS §2).
 */
import * as vscode from 'vscode';

export interface ComparisonEntry {
  rawText: string;
  primaryEngine: string;
  primaryText: string;
  primaryMs: number;
  altEngine?: string;
  altText?: string;
  altMs?: number;
  altError?: string;
}

export class RewriteComparisonViewer implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;

  constructor() {
    this.channel = vscode.window.createOutputChannel('VibeFox: Rewrite Comparison');
  }

  log(entry: ComparisonEntry): void {
    const time = new Date().toLocaleTimeString();
    this.channel.appendLine(`──── ${time} ────`);
    this.channel.appendLine(`原始转写: ${entry.rawText}`);
    this.channel.appendLine(`${entry.primaryEngine}(${entry.primaryMs}ms): ${entry.primaryText}`);
    const altName = entry.altEngine ?? '对比引擎';
    if (entry.altError) {
      this.channel.appendLine(`${altName}: 出错(${entry.altError})`);
    } else if (entry.altText !== undefined) {
      this.channel.appendLine(`${altName}(${entry.altMs}ms): ${entry.altText}`);
    }
    this.channel.appendLine('');
  }

  dispose(): void {
    this.channel.dispose();
  }
}
