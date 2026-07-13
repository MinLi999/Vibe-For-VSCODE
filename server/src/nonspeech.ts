/**
 * Non-speech / hallucination transcript detector — MUST stay in sync with the client copy
 * (client/src/controllers/VibeController.ts isNonSpeechTranscript). ASR engines answer silence
 * or corrupted audio with ellipses, bracketed scene descriptions ("(音频中充斥着强烈的机械噪音…)"),
 * or subtitle-watermark spam. Detecting it server-side skips the pointless (and billed) rewrite
 * stage and returns the same 502 the client already treats as "no speech".
 */

const PUNCTUATION_ONLY = /^[\s.。,，、;；:：!！?？~〜…·\-—_*]+$/;
const BRACKETED_DESCRIPTION = /^[(（\[【][^)）\]】]{0,120}[)）\]】]$/;
const AUDIO_NARRATION = /^(音频|本段音频|该音频|此音频|背景音)/;
const SUBTITLE_SPAM = ['点赞', '订阅', '字幕', 'amara.org', '谢谢观看', 'thank you for watching', 'thanks for watching'];

export function isNonSpeechTranscript(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) {
    return true;
  }
  if (PUNCTUATION_ONLY.test(t)) {
    return true;
  }
  if (BRACKETED_DESCRIPTION.test(t)) {
    return true;
  }
  if (AUDIO_NARRATION.test(t)) {
    return true;
  }
  if (t.length <= 30) {
    const lower = t.toLowerCase();
    if (SUBTITLE_SPAM.some((s) => lower.includes(s))) {
      return true;
    }
  }
  return false;
}
