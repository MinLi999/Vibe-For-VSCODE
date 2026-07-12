/**
 * Service layer: system-level paste keystroke simulation (macOS AppleScript).
 * Sandboxed webview chat inputs (Copilot Chat / Cline) have no cross-extension write API;
 * after the Controller focuses a chat panel with the text on the clipboard, this service
 * fires ⌘V so the text lands in the focused input. I/O only — no vscode UI (02-STANDARDS §2).
 */
import { exec } from 'node:child_process';

export class SystemPasteService {
  /**
   * Best-effort ⌘V after a short focus-settling delay. No-op on non-macOS platforms.
   * Failures (e.g. missing Accessibility permission) are swallowed — the text is already
   * on the clipboard, so the user can paste manually.
   */
  async simulatePaste(delayMs = 150): Promise<void> {
    if (process.platform !== 'darwin') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    exec(`osascript -e 'tell application "System Events" to keystroke "v" using {command down}'`, () => {
      // Silent: missing Assistive Access permission must not crash the flow.
    });
  }
}
