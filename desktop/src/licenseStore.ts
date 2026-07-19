/**
 * License key storage. On macOS the key lives in the login Keychain (the desktop equivalent of
 * VS Code SecretStorage — see CLAUDE.md secret red line); other platforms fall back to a
 * 0600-permission file in the userData dir. Never logged, never in config.json.
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const KEYCHAIN_SERVICE = 'VibeFox';
const KEYCHAIN_ACCOUNT = 'license';

function security(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile('security', args, (error, stdout) => {
      const code = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
        ? ((error as unknown as { code: number }).code)
        : error ? 1 : 0;
      resolve({ code, stdout: stdout ?? '' });
    });
  });
}

function fallbackFile(userDataDir: string): string {
  return path.join(userDataDir, 'license.key');
}

export async function getLicenseKey(userDataDir: string): Promise<string | null> {
  if (process.platform === 'darwin') {
    const { code, stdout } = await security([
      'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w',
    ]);
    const key = stdout.trim();
    return code === 0 && key.length > 0 ? key : null;
  }
  try {
    const key = fs.readFileSync(fallbackFile(userDataDir), 'utf8').trim();
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

export async function setLicenseKey(userDataDir: string, key: string): Promise<void> {
  if (process.platform === 'darwin') {
    // -U updates in place when the item already exists.
    await security([
      'add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w', key,
    ]);
    return;
  }
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(fallbackFile(userDataDir), key, { encoding: 'utf8', mode: 0o600 });
}

export async function clearLicenseKey(userDataDir: string): Promise<void> {
  if (process.platform === 'darwin') {
    await security(['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT]);
    return;
  }
  try {
    fs.unlinkSync(fallbackFile(userDataDir));
  } catch {
    /* Already gone. */
  }
}
