/**
 * Service layer: reads the user's keybindings.json across known IDE config dirs to find
 * the actual shortcut bound to vibefox.toggleRecording (shown in status bar / messages).
 * Pure file I/O — no vscode UI (02-STANDARDS §2).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DEFAULT_KEY = 'Ctrl+Shift+Space';
const APP_DIRS = ['Antigravity IDE', 'Cursor', 'Code', 'Code - Insiders', 'VSCodium'];

export class KeybindingLookupService {
  getActiveKeybinding(): string {
    for (const appDir of APP_DIRS) {
      try {
        const home = os.homedir();
        let userFolder = '';
        if (process.platform === 'darwin') {
          userFolder = path.join(home, 'Library', 'Application Support', appDir, 'User');
        } else if (process.platform === 'win32') {
          const appdata = process.env['APPDATA'] || path.join(home, 'AppData', 'Roaming');
          userFolder = path.join(appdata, appDir, 'User');
        } else {
          userFolder = path.join(home, '.config', appDir, 'User');
        }

        const keybindingsPath = path.join(userFolder, 'keybindings.json');
        if (!fs.existsSync(keybindingsPath)) {
          continue;
        }
        const content = fs.readFileSync(keybindingsPath, 'utf8');
        // keybindings.json is JSONC — strip comments before parsing.
        const cleanContent = content.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '$1');
        const bindings = JSON.parse(cleanContent) as unknown;
        if (Array.isArray(bindings)) {
          const match = bindings.find(
            (b: { command?: string; key?: string }) => b.command === 'vibefox.toggleRecording',
          );
          if (match && typeof match.key === 'string') {
            return match.key
              .split('+')
              .map((part: string) => part.trim().charAt(0).toUpperCase() + part.trim().slice(1))
              .join('+');
          }
        }
      } catch {
        // Continue searching in other app dirs.
      }
    }
    return DEFAULT_KEY;
  }
}
