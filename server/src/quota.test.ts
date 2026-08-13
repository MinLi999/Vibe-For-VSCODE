import { describe, expect, it } from 'vitest';

import { HttpError } from './errors';
import {
  DEFAULT_MONTHLY_AUDIO_LIMIT_SECONDS,
  enforceMonthlyQuota,
  estimateAudioSeconds,
  monthlyLimitSeconds,
  readUsage,
  recordUsage,
  usageKey,
} from './quota';
import type { Env } from './types';

/** In-memory KV double that records puts so TTL/values can be asserted. */
function kvEnv(initial: Record<string, string> = {}, limit?: string, failing = false): Env & { store: Record<string, string> } {
  const store = { ...initial };
  return {
    store,
    ...(limit !== undefined ? { MONTHLY_AUDIO_LIMIT_SECONDS: limit } : {}),
    AUTH_KEYS: {
      get: async (key: string) => {
        if (failing) throw new Error('kv down');
        return store[key] ?? null;
      },
      put: async (key: string, value: string) => {
        if (failing) throw new Error('kv down');
        store[key] = value;
      },
    },
  } as unknown as Env & { store: Record<string, string> };
}

const JAN = new Date(Date.UTC(2026, 0, 15));
const FEB = new Date(Date.UTC(2026, 1, 1));

describe('estimateAudioSeconds', () => {
  it('derives duration from payload size, not client claims (tamper-resistant)', () => {
    // 1 minute of ~32kbps audio ≈ 240KB raw ≈ 320K base64 chars.
    expect(estimateAudioSeconds(320_000)).toBeCloseTo(60, 0);
    expect(estimateAudioSeconds(0)).toBe(0);
  });
});

describe('usageKey', () => {
  it('buckets by UTC month so usage rolls over on the 1st', () => {
    expect(usageKey('vf-abc', JAN)).toBe('usage:vf-abc:2026-01');
    expect(usageKey('vf-abc', FEB)).toBe('usage:vf-abc:2026-02');
  });
});

describe('monthlyLimitSeconds', () => {
  it('defaults to 30 hours', () => {
    expect(monthlyLimitSeconds(kvEnv())).toBe(DEFAULT_MONTHLY_AUDIO_LIMIT_SECONDS);
    expect(DEFAULT_MONTHLY_AUDIO_LIMIT_SECONDS).toBe(108_000);
  });

  it('"0" means unlimited — the self-hoster setting', () => {
    expect(monthlyLimitSeconds(kvEnv({}, '0'))).toBe(0);
  });

  it('honors a custom limit and ignores garbage rather than disabling the cap', () => {
    expect(monthlyLimitSeconds(kvEnv({}, '3600'))).toBe(3600);
    expect(monthlyLimitSeconds(kvEnv({}, 'not-a-number'))).toBe(DEFAULT_MONTHLY_AUDIO_LIMIT_SECONDS);
    expect(monthlyLimitSeconds(kvEnv({}, '-5'))).toBe(DEFAULT_MONTHLY_AUDIO_LIMIT_SECONDS);
  });
});

describe('enforceMonthlyQuota', () => {
  it('allows a key under its allowance', async () => {
    const env = kvEnv({ 'usage:vf-abc:2026-01': '1000' });
    await expect(enforceMonthlyQuota(env, 'vf-abc', JAN)).resolves.toBeUndefined();
  });

  it('rejects with 402 (not 429) once the allowance is spent', async () => {
    const env = kvEnv({ 'usage:vf-abc:2026-01': String(DEFAULT_MONTHLY_AUDIO_LIMIT_SECONDS) });
    await expect(enforceMonthlyQuota(env, 'vf-abc', JAN)).rejects.toSatisfy(
      (e: unknown) => e instanceof HttpError && e.status === 402,
    );
  });

  it('a new month resets the allowance', async () => {
    const env = kvEnv({ 'usage:vf-abc:2026-01': String(DEFAULT_MONTHLY_AUDIO_LIMIT_SECONDS * 2) });
    await expect(enforceMonthlyQuota(env, 'vf-abc', FEB)).resolves.toBeUndefined();
  });

  it('never enforces when unlimited (self-hosted)', async () => {
    const env = kvEnv({ 'usage:vf-abc:2026-01': '999999999' }, '0');
    await expect(enforceMonthlyQuota(env, 'vf-abc', JAN)).resolves.toBeUndefined();
  });

  it('FAILS OPEN when KV is unavailable — an outage must not block paying users', async () => {
    const env = kvEnv({}, undefined, true);
    await expect(enforceMonthlyQuota(env, 'vf-abc', JAN)).resolves.toBeUndefined();
  });

  it('quota is per key — one heavy user cannot exhaust another', async () => {
    const env = kvEnv({ 'usage:heavy:2026-01': String(DEFAULT_MONTHLY_AUDIO_LIMIT_SECONDS) });
    await expect(enforceMonthlyQuota(env, 'heavy', JAN)).rejects.toThrow();
    await expect(enforceMonthlyQuota(env, 'light', JAN)).resolves.toBeUndefined();
  });
});

describe('recordUsage', () => {
  it('accumulates within the month bucket', async () => {
    const env = kvEnv();
    await recordUsage(env, 'vf-abc', 30, JAN);
    await recordUsage(env, 'vf-abc', 45.4, JAN);
    expect(env.store['usage:vf-abc:2026-01']).toBe('75'); // Rounded.
  });

  it('does not write at all when unlimited (no KV traffic for self-hosters)', async () => {
    const env = kvEnv({}, '0');
    await recordUsage(env, 'vf-abc', 100, JAN);
    expect(Object.keys(env.store)).toHaveLength(0);
  });

  it('swallows KV failures — accounting loss beats failing a served request', async () => {
    const env = kvEnv({}, undefined, true);
    await expect(recordUsage(env, 'vf-abc', 30, JAN)).resolves.toBeUndefined();
  });

  it('recovers from a corrupted counter instead of propagating NaN', async () => {
    const env = kvEnv({ 'usage:vf-abc:2026-01': 'garbage' });
    await recordUsage(env, 'vf-abc', 60, JAN);
    expect(env.store['usage:vf-abc:2026-01']).toBe('60');
  });
});

describe('readUsage', () => {
  it('reports remaining allowance for the client display', async () => {
    const env = kvEnv({ 'usage:vf-abc:2026-01': '3600' });
    const usage = await readUsage(env, 'vf-abc', JAN);
    expect(usage.usedSeconds).toBe(3600);
    expect(usage.limitSeconds).toBe(DEFAULT_MONTHLY_AUDIO_LIMIT_SECONDS);
    expect(usage.remainingSeconds).toBe(DEFAULT_MONTHLY_AUDIO_LIMIT_SECONDS - 3600);
  });

  it('reports zero remaining (not negative) once over', async () => {
    const env = kvEnv({ 'usage:vf-abc:2026-01': String(DEFAULT_MONTHLY_AUDIO_LIMIT_SECONDS + 5000) });
    expect((await readUsage(env, 'vf-abc', JAN)).remainingSeconds).toBe(0);
  });
});
