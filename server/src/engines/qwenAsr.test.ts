import { describe, expect, it } from 'vitest';

import { asrTimeoutMs } from './qwenAsr';

/** base64 length for N seconds of ~32kbps audio (4000 bytes/s, base64 inflates 4/3). */
const base64LenFor = (seconds: number) => Math.round(seconds * 4000 * (4 / 3));

describe('asrTimeoutMs', () => {
  it('keeps the historical 6s floor for short utterances', () => {
    expect(asrTimeoutMs(base64LenFor(1))).toBeGreaterThanOrEqual(6_000);
    expect(asrTimeoutMs(base64LenFor(3))).toBeLessThan(8_000);
  });

  it('scales with audio length so long takes are not killed mid-flight', () => {
    // The bug this fixes: a 60s take needs ~6-12s of processing but the old flat 6s deadline
    // aborted it every time, fell through to Whisper, and surfaced as a silent 502.
    const oneMinute = asrTimeoutMs(base64LenFor(60));
    expect(oneMinute).toBeGreaterThan(20_000);
    expect(asrTimeoutMs(base64LenFor(120))).toBeGreaterThan(oneMinute - 1); // monotonic
  });

  it('caps so a hung request still fails inside the client 60s ceiling', () => {
    expect(asrTimeoutMs(base64LenFor(600))).toBeLessThanOrEqual(25_000);
  });
});
