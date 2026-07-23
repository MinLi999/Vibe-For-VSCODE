import { describe, expect, it } from 'vitest';
import { buildSessionUpdate, clampSilenceMs, classifyUpstreamEvent, parseClientStart, realtimeUpstreamUrl } from './realtime';

describe('clampSilenceMs', () => {
  it('defaults to 800 and clamps into [400, 2000]', () => {
    expect(clampSilenceMs(undefined)).toBe(800);
    expect(clampSilenceMs(Number.NaN)).toBe(800);
    expect(clampSilenceMs(100)).toBe(400);
    expect(clampSilenceMs(1200)).toBe(1200);
    expect(clampSilenceMs(9000)).toBe(2000);
  });
});

describe('realtimeUpstreamUrl', () => {
  it('uses the per-workspace Singapore host when a workspace id is configured', () => {
    expect(realtimeUpstreamUrl('ws-abc')).toBe(
      'wss://ws-abc.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime',
    );
  });

  it('falls back to the legacy shared intl host so streaming works without a workspace id', () => {
    const expected = 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime';
    expect(realtimeUpstreamUrl(undefined)).toBe(expected);
    expect(realtimeUpstreamUrl('')).toBe(expected);
    expect(realtimeUpstreamUrl('   ')).toBe(expected);
  });
});

describe('buildSessionUpdate', () => {
  it('omits the language on auto (self-detect policy, same as the batch path)', () => {
    const session = buildSessionUpdate({ silenceMs: 800, language: 'auto' })['session'] as Record<string, unknown>;
    expect(session['input_audio_transcription']).toBeUndefined();
    expect(session['turn_detection']).toEqual({ type: 'server_vad', silence_duration_ms: 800 });
    expect(session['input_audio_format']).toBe('pcm');
    expect(session['sample_rate']).toBe(16000);
  });

  it('forwards an explicit language lock', () => {
    const session = buildSessionUpdate({ silenceMs: 400, language: 'zh' })['session'] as Record<string, unknown>;
    expect(session['input_audio_transcription']).toEqual({ language: 'zh' });
  });
});

describe('classifyUpstreamEvent', () => {
  it('classifies completed utterances, partials, finish and errors', () => {
    expect(
      classifyUpstreamEvent({ type: 'conversation.item.input_audio_transcription.completed', transcript: '你好' }),
    ).toEqual({ kind: 'completed', text: '你好' });
    expect(classifyUpstreamEvent({ type: 'conversation.item.input_audio_transcription.text', text: '你' })).toEqual({
      kind: 'partial',
      text: '你',
    });
    expect(classifyUpstreamEvent({ type: 'session.finished' })).toEqual({ kind: 'session_finished' });
    expect(classifyUpstreamEvent({ type: 'error', message: 'boom' })).toEqual({ kind: 'error', message: 'boom' });
  });

  it('ignores unknown/malformed events instead of crashing the relay', () => {
    expect(classifyUpstreamEvent({ type: 'input_audio_buffer.speech_started' })).toEqual({ kind: 'ignore' });
    expect(classifyUpstreamEvent(null)).toEqual({ kind: 'ignore' });
    expect(classifyUpstreamEvent('nonsense')).toEqual({ kind: 'ignore' });
  });
});

describe('parseClientStart', () => {
  it('rejects non-start frames', () => {
    expect(parseClientStart({ type: 'audio' })).toBeNull();
    expect(parseClientStart(null)).toBeNull();
  });

  it('applies safe defaults and caps keywords at 40', () => {
    const parsed = parseClientStart({ type: 'start', keywords: Array.from({ length: 60 }, (_, i) => `k${i}`) });
    expect(parsed?.rewriteMode).toBe('clean');
    expect(parsed?.keywords).toHaveLength(40);
    expect(parsed?.appCategory).toBeUndefined();
  });

  it('whitelists appCategory and rewriteMode', () => {
    const parsed = parseClientStart({ type: 'start', rewriteMode: 'rewrite', appCategory: 'email' });
    expect(parsed?.rewriteMode).toBe('rewrite');
    expect(parsed?.appCategory).toBe('email');
    expect(parseClientStart({ type: 'start', appCategory: 'evil' })?.appCategory).toBeUndefined();
    expect(parseClientStart({ type: 'start', rewriteMode: 'evil' })?.rewriteMode).toBe('clean');
  });
});
