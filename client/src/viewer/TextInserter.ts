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
  /** needsSystemPaste: a webview chat panel took focus with the text on the clipboard —
   *  the Controller should trigger a system-level paste (viewer must not spawn processes). */
  | { via: 'chat'; needsSystemPaste: boolean }
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

    // Only fire commands that are actually registered in this IDE. The previous blind-fire
    // approach fell through to `workbench.action.chat.open` (a built-in that ALWAYS exists and
    // ALWAYS "succeeds") whenever none of the listed commands existed — hijacking the flow into
    // Copilot Chat even when the user's actual agent panel (e.g. Claude Code) was installed.
    const available = new Set(await vscode.commands.getCommands(true));

    // Priority order: Claude Code (this product's primary target) → other agent panels.
    const chatCommands = [
      'claude-vscode.focus',                     // Claude Code: Focus input (anthropic.claude-code)
      'claude-vscode.sidebar.open',              // Claude Code: Open in Side Bar (fallback)
      'cloudcode.gemini.chatView.focus',         // Antigravity IDE (Gemini Chat)
      'workbench.view.extension.geminiChat',     // Antigravity IDE (alt)
      'composer.openOrFocus',                    // Cursor Composer
      'aichat.newfollowupaction',                // Cursor AIChat
      'composerMode.agent',                      // Cursor Agent Mode
      'cline.plusButtonClicked',                 // Cline (Claude Dev)
      'continue.focusContinueInput',             // Continue
      'cody.chat.focus',                         // Sourcegraph Cody
      'aws.amazonq.chat.focus',                  // Amazon Q
      'cascade.openOrFocus',                     // Windsurf (Cascade)
    ];

    let focused = false;
    for (const cmd of chatCommands) {
      if (!available.has(cmd)) {
        continue;
      }
      try {
        await vscode.commands.executeCommand(cmd);
        focused = true;
        break; // Stop at the first successful command — don't fire the rest
      } catch {
        // Registered but failed (e.g. view disposed); try next
      }
    }

    if (focused) {
      // A webview chat panel has focus with the text on the clipboard; process spawning is
      // forbidden in the viewer, so the Controller performs the system paste.
      return { via: 'chat', needsSystemPaste: true };
    }

    // Built-in Copilot Chat only as a LAST resort, and only when Copilot Chat is actually
    // installed — otherwise this just opens an empty chat panel the user never asked for.
    if (vscode.extensions.getExtension('github.copilot-chat') !== undefined) {
      try {
        await vscode.commands.executeCommand('workbench.action.chat.open', {
          query: text,
          isPartialQuery: true,
        });
        // Copilot Chat has a native query API — no system paste needed.
        return { via: 'chat', needsSystemPaste: false };
      } catch {
        // Ignore built-in Copilot Chat open failure
      }
    }

    // No chat surface found: the text is on the clipboard; report that honestly instead of
    // blind-pasting into whatever happens to have focus.
    return { via: 'clipboard' };
  }

  private async intoClipboard(text: string): Promise<InsertOutcome> {
    await vscode.env.clipboard.writeText(text);
    return { via: 'clipboard' };
  }
}
