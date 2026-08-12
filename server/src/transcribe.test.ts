import { describe, expect, it } from 'vitest';

import { parseRequestBody } from './transcribe';

const AUDIO = 'QUJD'; // "ABC" — any valid base64.
const MAX = 1024;

describe('parseRequestBody audioFormat', () => {
  it('defaults to mp3 when the field is absent (v1/v2 legacy clients)', () => {
    expect(parseRequestBody({ audio: AUDIO, rewriteMode: 'clean' }, MAX).audioFormat).toBe('mp3');
  });

  it('accepts m4a (native macOS client) and wav', () => {
    expect(parseRequestBody({ audio: AUDIO, rewriteMode: 'clean', audioFormat: 'm4a' }, MAX).audioFormat).toBe('m4a');
    expect(parseRequestBody({ audio: AUDIO, rewriteMode: 'clean', audioFormat: 'wav' }, MAX).audioFormat).toBe('wav');
  });

  it('silently falls back to mp3 on unknown containers (forward compat, no 400)', () => {
    expect(parseRequestBody({ audio: AUDIO, rewriteMode: 'clean', audioFormat: 'ogg' }, MAX).audioFormat).toBe('mp3');
    expect(parseRequestBody({ audio: AUDIO, rewriteMode: 'clean', audioFormat: 42 }, MAX).audioFormat).toBe('mp3');
  });
});
