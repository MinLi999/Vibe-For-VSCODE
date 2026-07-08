import type { Env, LicenseMetadata } from './types';

export type AuthResult =
  | { ok: true; key: string; metadata: LicenseMetadata | null }
  | { ok: false; status: 401 | 403; message: string };

/**
 * `Authorization: Bearer <LICENSE_KEY>` → existence check against AUTH_KEYS KV.
 * Missing/malformed header → 401; key not found in KV → 403.
 * Keys are issued/revoked entirely via `wrangler kv key put/delete`; this code only checks existence.
 */
export async function authenticate(request: Request, env: Env): Promise<AuthResult> {
  const header = request.headers.get('Authorization');
  if (!header) {
    return { ok: false, status: 401, message: 'Missing Authorization header' };
  }

  const match = /^Bearer\s+(\S+)$/.exec(header);
  if (!match || !match[1]) {
    return { ok: false, status: 401, message: 'Malformed Authorization header, expected: Bearer <LICENSE_KEY>' };
  }

  const key = match[1];
  const stored = await env.AUTH_KEYS.get(key);
  if (stored === null) {
    return { ok: false, status: 403, message: 'Invalid or revoked license key' };
  }

  let metadata: LicenseMetadata | null = null;
  try {
    metadata = JSON.parse(stored) as LicenseMetadata;
  } catch {
    // Value isn't JSON (e.g. someone manually put "1") — still allowed through; auth only checks existence.
  }

  return { ok: true, key, metadata };
}
