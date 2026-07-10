/**
 * Viewer layer: writes transcribed text into the UI — editor cursor / active terminal (Claude Code CLI) / clipboard.
 * Constraint: webview chat inputs (Copilot Chat / Cline) have no cross-extension write API;
 * clipboard + user paste is the reliable path (PRD module D). This layer only executes the
 * insertion strategy, no business logic beyond that.
 */
import * as vscode from 'vscode';

export type InsertTarget = 'auto' | 'editor' | 'terminal' | 'clipboard' | 'chat';

export type InsertOutcome =
  | { via: 'editor' }
  | { via: 'terminal'; terminalName: string }
  | { via: 'chat' }
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
      case 'chat':
        return this.intoChat(text);
      case 'clipboard':
        return this.intoClipboard(text);
      case 'auto': {
        if (vscode.window.activeTextEditor !== undefined) {
          return this.intoEditor(text);
        }
        if (vscode.window.activeTerminal !== undefined) {
          return this.intoTerminal(text);
        }
        try {
          return await this.intoChat(text);
        } catch {
          return this.intoClipboard(text);
        }
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

  private async intoChat(text: string): Promise<InsertOutcome> {
    // Always copy to clipboard as a fallback/safety net first, in case it's a custom webview chat
    await this.intoClipboard(text);

    const isCursor = vscode.env.appName.toLowerCase().includes('cursor');
    if (isCursor) {
      // Try to open/focus Cursor Composer or Chat panels sequentially
      const cursorCommands = [
        'composer.openOrFocus',
        'aichat.newfollowupaction',
        'composerMode.agent',
      ];
      for (const cmd of cursorCommands) {
        try {
          await vscode.commands.executeCommand(cmd);
        } catch {
          // Ignore if command is not registered/fails
        }
      }
    } else {
      try {
        await vscode.commands.executeCommand('workbench.action.chat.open', {
          query: text,
          isPartialQuery: true,
        });
      } catch (err) {
        // Ignore built-in Copilot Chat open failure
      }
    }

    // On macOS, try to trigger a system-level paste via AppleScript so it enters any active focused webview input (best effort)
    if (process.platform === 'darwin') {
      try {
        const { exec } = require('child_process');
        // Give 150ms for the chat/composer pane to gain focus before triggering paste
        await new Promise((resolve) => setTimeout(resolve, 150));
        exec(`osascript -e 'tell application "System Events" to keystroke "v" using {command down}'`, (error: any) => {
          // Silent catch to prevent crash if Assistive Access (Accessibility) permissions are missing in macOS Settings
        });
      } catch {
        // Ignore if child_process fails
      }
    }

    return { via: 'chat' };
  }

  private async intoClipboard(text: string): Promise<InsertOutcome> {
    await vscode.env.clipboard.writeText(text);
    return { via: 'clipboard' };
  }
}
