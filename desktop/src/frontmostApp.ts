/**
 * Detects which app the transcription will be pasted into, so the rewrite stage can adapt
 * punctuation/formality per target (chat vs email vs notes). macOS only for now: System
 * Events exposes the frontmost process's bundle id via the same Apple-events permission the
 * paste path already needs. Detection failures degrade to undefined (no tone hint sent).
 */
import { exec } from 'node:child_process';

import type { AppCategory } from '../../client/src/services/CloudflareApiService';

/** Substring → category. First match wins; anything unmatched (browsers included) is 'other'. */
const BUNDLE_ID_CATEGORIES: [string, AppCategory][] = [
  // AI / messaging chat clients — the desktop app's primary use case.
  ['com.anthropic.claudefordesktop', 'chat'],
  ['com.openai.chat', 'chat'],
  ['com.tinyspeck.slackmacgap', 'chat'],
  ['com.hnc.Discord', 'chat'],
  ['ru.keepcoder.Telegram', 'chat'],
  ['com.tencent.xinWeChat', 'chat'],
  ['net.whatsapp.WhatsApp', 'chat'],
  ['com.microsoft.teams', 'chat'],
  // Email
  ['com.apple.mail', 'email'],
  ['com.microsoft.Outlook', 'email'],
  ['com.readdle.smartemail', 'email'],
  ['com.airmailapp', 'email'],
  // Notes / writing
  ['com.apple.Notes', 'notes'],
  ['notion.id', 'notes'],
  ['md.obsidian', 'notes'],
  ['com.apple.TextEdit', 'notes'],
  ['net.shinyfrog.bear', 'notes'],
  ['com.craft.docs', 'notes'],
  // IDEs / editors
  ['com.microsoft.VSCode', 'ide'],
  ['com.todesktop.', 'ide'], // Cursor and other ToDesktop-packaged editors
  ['com.jetbrains.', 'ide'],
  ['com.google.android.studio', 'ide'],
  ['com.sublimetext.', 'ide'],
  ['dev.zed.Zed', 'ide'],
  ['com.exafunction.windsurf', 'ide'],
  // Terminals
  ['com.apple.Terminal', 'terminal'],
  ['com.googlecode.iterm2', 'terminal'],
  ['dev.warp.Warp', 'terminal'],
  ['com.github.wez.wezterm', 'terminal'],
  ['net.kovidgoyal.kitty', 'terminal'],
];

export function categorizeBundleId(bundleId: string): AppCategory {
  const id = bundleId.trim();
  for (const [needle, category] of BUNDLE_ID_CATEGORIES) {
    if (id.startsWith(needle) || id.includes(needle)) {
      return category;
    }
  }
  return 'other';
}

/** Resolves the frontmost app's category, or undefined when detection is unavailable/fails. */
export function frontmostAppCategory(): Promise<AppCategory | undefined> {
  if (process.platform !== 'darwin') {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    exec(
      `osascript -e 'tell application "System Events" to get bundle identifier of first application process whose frontmost is true'`,
      { timeout: 1500 },
      (err, stdout) => {
        if (err || stdout.trim().length === 0) {
          resolve(undefined);
          return;
        }
        resolve(categorizeBundleId(stdout));
      },
    );
  });
}
