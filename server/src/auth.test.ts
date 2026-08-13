import { describe, expect, it } from 'vitest';

import { authenticate } from './auth';
import type { Env } from './types';

/** Minimal KV double: only `get` is exercised by authenticate. */
function envWithKeys(store: Record<string, string>): Env {
  return {
    AUTH_KEYS: {
      get: async (key: string) => store[key] ?? null,
    },
  } as unknown as Env;
}

function requestWithAuth(header?: string): Request {
  return new Request('https://worker.test/api/transcribe', {
    method: 'POST',
    headers: header !== undefined ? { Authorization: header } : {},
  });
}

describe('authenticate', () => {
  it('401 when the Authorization header is missing', async () => {
    const result = await authenticate(requestWithAuth(), envWithKeys({}));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(401);
  });

  it('401 on a malformed header (not Bearer <token>)', async () => {
    for (const bad of ['vf-key-123', 'Basic abc', 'Bearer', 'Bearer  ']) {
      const result = await authenticate(requestWithAuth(bad), envWithKeys({ 'vf-key-123': '1' }));
      expect(result.ok, bad).toBe(false);
      if (!result.ok) expect(result.status, bad).toBe(401);
    }
  });

  it('403 when the key is not in KV (revoked/unknown)', async () => {
    const result = await authenticate(requestWithAuth('Bearer nope'), envWithKeys({ real: '1' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it('passes a valid key through with parsed metadata', async () => {
    const env = envWithKeys({ 'vf-pro': JSON.stringify({ owner: 'elvis', plan: 'pro' }) });
    const result = await authenticate(requestWithAuth('Bearer vf-pro'), env);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.key).toBe('vf-pro');
      expect(result.metadata?.plan).toBe('pro');
    }
  });

  it('tolerates non-JSON KV values — auth is existence-only', async () => {
    const result = await authenticate(requestWithAuth('Bearer legacy'), envWithKeys({ legacy: 'not-json{{' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.metadata).toBeNull();
  });

  it('a hand-issued "1" parses as the NUMBER 1 (valid JSON!) and still lands on the free tier', async () => {
    // Documents a subtlety the source comment gets wrong: '1' IS valid JSON, so metadata
    // becomes the number 1 — harmless, because (1).plan is undefined => free tier.
    const result = await authenticate(requestWithAuth('Bearer legacy'), envWithKeys({ legacy: '1' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.metadata as unknown as { plan?: string })?.plan).toBeUndefined();
    }
  });
});
