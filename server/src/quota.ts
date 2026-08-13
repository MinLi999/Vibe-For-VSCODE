import { HttpError } from './errors';
import type { Env } from './types';

/**
 * Monthly fair-use cap on transcribed audio, per license key.
 *
 * Why this exists: at ~$0.126/hour of audio plus rewrite tokens, a normal user costs $0.5-6
 * a month, but an extreme user (hours of continuous dictation daily) can exceed a flat
 * subscription price. The cap is a guard against that tail, NOT a billing meter — it is
 * deliberately approximate and fails OPEN, because wrongly blocking a paying user is far
 * worse than letting an outlier through.
 *
 * Scope: this only ever runs on a hosted Worker. BYOK users call their provider directly and
 * never reach this code; self-hosters run their own Worker and set their own limit (0 =
 * unlimited) via MONTHLY_AUDIO_LIMIT_SECONDS.
 */

/** 30 hours/month — covers heavy daily use; only the extreme tail hits it. */
export const DEFAULT_MONTHLY_AUDIO_LIMIT_SECONDS = 30 * 3600;

/**
 * Audio seconds are ESTIMATED from the payload size rather than taken from the client,
 * because a client-supplied duration is trivially forgeable and this is the abuse guard.
 * Matches the estimate used for timeout scaling (AAC/MP3 at the client's 32-64kbps).
 */
const APPROX_BYTES_PER_AUDIO_SECOND = 4_000;

export function estimateAudioSeconds(audioBase64Length: number): number {
  return (audioBase64Length * 0.75) / APPROX_BYTES_PER_AUDIO_SECOND;
}

/** UTC month bucket; usage rolls over at the start of each UTC month. */
export function usageKey(licenseKey: string, now: Date = new Date()): string {
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return `usage:${licenseKey}:${month}`;
}

export function monthlyLimitSeconds(env: Env): number {
  const configured = env.MONTHLY_AUDIO_LIMIT_SECONDS;
  if (configured === undefined || configured === '') {
    return DEFAULT_MONTHLY_AUDIO_LIMIT_SECONDS;
  }
  const parsed = Number(configured);
  // 0 = unlimited (self-hosters); a malformed value falls back to the default rather than
  // accidentally disabling the cap.
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MONTHLY_AUDIO_LIMIT_SECONDS;
}

export interface UsageSnapshot {
  usedSeconds: number;
  limitSeconds: number;
  /** 0 when unlimited. */
  remainingSeconds: number;
}

export async function readUsage(env: Env, licenseKey: string, now: Date = new Date()): Promise<UsageSnapshot> {
  const limitSeconds = monthlyLimitSeconds(env);
  let usedSeconds = 0;
  try {
    const stored = await env.AUTH_KEYS.get(usageKey(licenseKey, now));
    const parsed = stored === null ? 0 : Number(stored);
    usedSeconds = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    // KV unavailable → report zero usage; enforcement fails open by design.
  }
  return {
    usedSeconds,
    limitSeconds,
    remainingSeconds: limitSeconds === 0 ? 0 : Math.max(0, limitSeconds - usedSeconds),
  };
}

/**
 * Throws 402 when the key has already exhausted this month's allowance. Checked BEFORE the
 * expensive engines run, so an over-quota request costs nothing to reject.
 * 402 (not 429) so clients can distinguish "you're out of allowance this month" from
 * "you're going too fast, retry shortly" — the two need very different user-facing messages.
 */
export async function enforceMonthlyQuota(env: Env, licenseKey: string, now: Date = new Date()): Promise<void> {
  const { usedSeconds, limitSeconds } = await readUsage(env, licenseKey, now);
  if (limitSeconds === 0 || usedSeconds < limitSeconds) {
    return;
  }
  const hours = (limitSeconds / 3600).toFixed(0);
  throw new HttpError(
    402,
    `本月转写时长已达上限(${hours} 小时),下月 1 日重置。可在设置中改用自己的 API Key 继续使用。`,
  );
}

/**
 * Records consumed audio after the engines ran. Best-effort: a failed write loses at most one
 * segment's worth of accounting, which is acceptable for a fair-use guard and much better than
 * failing a request the user already paid for in latency.
 *
 * Write frequency is safe by construction: VAD emits a segment at most every ~3s
 * (vadMinDurationMs) and the client serializes segments, so same-key writes stay well under
 * KV's one-write-per-second-per-key guidance.
 */
export async function recordUsage(
  env: Env,
  licenseKey: string,
  seconds: number,
  now: Date = new Date(),
): Promise<void> {
  if (monthlyLimitSeconds(env) === 0 || seconds <= 0) {
    return;
  }
  const key = usageKey(licenseKey, now);
  try {
    const stored = await env.AUTH_KEYS.get(key);
    const previous = stored === null ? 0 : Number(stored);
    const total = (Number.isFinite(previous) && previous > 0 ? previous : 0) + seconds;
    await env.AUTH_KEYS.put(key, String(Math.round(total)), {
      // Auto-clean: a month bucket is irrelevant ~70 days later, so old rows expire
      // themselves instead of accumulating forever in KV.
      expirationTtl: 70 * 24 * 3600,
    });
  } catch {
    // Best effort — see doc comment.
  }
}
