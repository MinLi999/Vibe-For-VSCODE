import { HttpError } from './errors';
import type { Env, Tier } from './types';

/**
 * Per-license-key rate limiting via Cloudflare's Rate Limiting binding
 * (zero-latency, per-colo counters — one license ≈ one user ≈ one colo, good enough for MVP;
 * strict global limiting would need Durable Objects).
 * Fails open when the binding is absent (e.g. local `wrangler dev` without unsafe bindings).
 */
export async function enforceRateLimit(env: Env, tier: Tier, licenseKey: string): Promise<void> {
  const limiter = tier === 'quality' ? env.RL_PRO : env.RL_FREE;
  if (!limiter) {
    return;
  }
  const { success } = await limiter.limit({ key: licenseKey });
  if (!success) {
    throw new HttpError(429, 'Too many requests, please slow down');
  }
}
