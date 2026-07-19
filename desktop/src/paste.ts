/**
 * Inserts text into whatever app is frontmost: clipboard write + simulated system paste
 * keystroke. This is the whole "input method" trick — the Claude desktop app's composer is
 * just a focused text field, so a synthetic Cmd+V lands the text exactly where the caret is.
 * macOS needs the Accessibility permission for the keystroke (System Events).
 */
import { clipboard } from 'electron';
import { exec } from 'node:child_process';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function systemPasteKeystroke(): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      exec(`osascript -e 'tell application "System Events" to keystroke "v" using {command down}'`, () => resolve());
    } else if (process.platform === 'win32') {
      exec(
        `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"`,
        () => resolve(),
      );
    } else {
      // Linux: xdotool if present; otherwise the text stays on the clipboard for a manual paste.
      exec('xdotool key --clearmodifiers ctrl+v', () => resolve());
    }
  });
}

/**
 * Puts `text` on the clipboard and fires the paste keystroke. When `restoreClipboard` is set,
 * the previous plain-text clipboard is put back ~1s later (only if nothing else replaced it).
 */
export async function pasteIntoFrontmostApp(text: string, restoreClipboard: boolean): Promise<void> {
  const previous = restoreClipboard ? clipboard.readText() : '';
  clipboard.writeText(text);
  await delay(120); // Let the clipboard write settle before the synthetic keystroke.
  await systemPasteKeystroke();
  if (restoreClipboard) {
    setTimeout(() => {
      if (clipboard.readText() === text) {
        clipboard.writeText(previous);
      }
    }, 1000);
  }
}
