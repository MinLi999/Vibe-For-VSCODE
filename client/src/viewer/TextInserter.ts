/**
 * Viewer layer: writes transcribed text into the UI — editor cursor / active terminal (Claude Code CLI) / clipboard.
 * Constraint: webview chat inputs (Copilot Chat / Cline) have no cross-extension write API;
 * clipboard + user paste is the reliable path (PRD module D). This layer only executes the
 * insertion strategy, no business logic beyond that.
 */
import * as vscode from 'vscode';

export type InsertTarget = 'auto' | 'editor' | 'terminal' | 'clipboard';

export type InsertOutcome =
  | { via: 'editor' }
  | { via: 'terminal'; terminalName: string }
  | { via: 'clipboard' };

export class TextInsertionError extends Error {}

export class TextInserter {
  /** Inserts per the target strategy; returns which path was actually taken so the Controller can notify the user. */
  async insert(text: string, target: InsertTarget): Promise<InsertOutcome> {
    switch (target) {
      case 'editor':
        return this.intoEditor(text);
      case 'terminal':
        return this.intoTerminal(text);
      case 'clipboard':
        return this.intoClipboard(text);
      case 'auto': {
        if (vscode.window.activeTextEditor !== undefined) {
          return this.intoEditor(text);
        }
        if (vscode.window.activeTerminal !== undefined) {
          return this.intoTerminal(text);
        }
        return this.intoClipboard(text);
      }
    }
  }

  private async intoEditor(text: string): Promise<InsertOutcome> {
    const editor = vscode.window.activeTextEditor;
    if (editor === undefined) {
      throw new TextInsertionError('没有活动编辑器可插入(insertTarget=editor)');
    }
    const applied = await editor.edit((editBuilder) => {
      for (const selection of editor.selections) {
        if (selection.isEmpty) {
          editBuilder.insert(selection.active, text);
        } else {
          editBuilder.replace(selection, text);
        }
      }
    });
    if (!applied) {
      throw new TextInsertionError('编辑器拒绝了插入(文档只读?)');
    }
    return { via: 'editor' };
  }

  private async intoTerminal(text: string): Promise<InsertOutcome> {
    const terminal = vscode.window.activeTerminal;
    if (terminal === undefined) {
      throw new TextInsertionError('没有活动终端可发送(insertTarget=terminal)');
    }
    // No trailing newline: hand the text to the Claude Code CLI's input line; whether to press Enter is the user's call.
    terminal.sendText(text, false);
    terminal.show(true);
    return { via: 'terminal', terminalName: terminal.name };
  }

  private async intoClipboard(text: string): Promise<InsertOutcome> {
    await vscode.env.clipboard.writeText(text);
    return { via: 'clipboard' };
  }
}
