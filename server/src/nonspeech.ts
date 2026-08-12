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
/**
 * Filler-ONLY utterances are non-speech. Root cause of the field-reported "every utterance
 * ends with a dangling 嗯": the VAD trailing segment (breath/mouth noise after the last word)
 * makes the ASR hallucinate a bare "嗯", which is under MIN_REWRITE_CHARS so the rewrite
 * stage (whose clean mode WOULD strip fillers) never runs, and it got pasted verbatim.
 * Only transcripts consisting ENTIRELY of filler tokens are dropped — "嗯,好的,开始吧"
 * keeps its meaning-bearing words and passes through untouched.
 */
const FILLER_TOKEN = /^(嗯+|呃+|啊+|哦+|噢+|唔+|呣+|哈+|嘛+|h+m+|u+m+|u+h+|e+m+|e+r+|m+|mhm+|emm+|hmm+)$/i;
const FILLER_SPLIT = /[\s.。,，、;；:：!！?？~〜…·\-—_*]+/;

function isFillerOnly(t: string): boolean {
  const tokens = t.split(FILLER_SPLIT).filter((token) => token.length > 0);
  return tokens.length > 0 && tokens.every((token) => FILLER_TOKEN.test(token));
}

/**
 * Guard for the Qwen3-ASR context-biasing channel: on near-silent audio the model has been
 * observed reading the injected context back out as the "transcription" (the 2026-07-12
 * incident that got the mechanism removed). Flags a transcript that is essentially nothing
 * but the injected vocabulary so the caller can treat it as degenerate and fall back.
 * Genuinely dictated keywords survive: real speech carries connective words around them,
 * and an utterance this short (< MIN_ECHO_CHECK_CHARS after normalization) is never a
 * full-list echo, so it is exempted rather than risk false positives on "commit" alone.
 */
const MIN_ECHO_CHECK_CHARS = 12;

export function isContextEcho(text: string, contextWords: string[]): boolean {
  if (contextWords.length === 0) {
    return false;
  }
  const normalize = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const normalized = normalize(text);
  if (normalized.length < MIN_ECHO_CHECK_CHARS) {
    return false;
  }
  // Longest-first so "Cloudflare Workers" is consumed before "Cloudflare" leaves a stub behind.
  let residual = normalized;
  const words = [...contextWords].map(normalize).filter((w) => w.length > 0);
  words.sort((a, b) => b.length - a.length);
  for (const word of words) {
    residual = residual.split(word).join('');
  }
  // If under 20% of the transcript remains once the injected vocabulary is removed, the
  // model was reciting the context, not transcribing speech.
  return residual.length / normalized.length < 0.2;
}

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
  // Bound the filler-only check to short utterances: a 30+ char transcript that tokenizes to
  // pure fillers doesn't occur in practice, and the bound keeps worst-case work trivial.
  if (t.length <= 30 && isFillerOnly(t)) {
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
