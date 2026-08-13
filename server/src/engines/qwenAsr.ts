import { EngineError } from '../errors';
import type { Env, RegionPreference } from '../types';
import { resolveDashscopeRegion } from './dashscopeRegion';

/**
 * Qwen3-ASR answers a 10s utterance in 1-2s, i.e. processing time scales WITH audio length —
 * so a fixed timeout is wrong. The original flat 6s silently killed every long dictation:
 * a 60s take needs ~6-12s, always tripped the deadline, fell through to Whisper (also slow on
 * long audio), and both coming back empty produced a 502 the client treats as ordinary silence.
 * That is the "I spoke for a minute and nothing appeared, history has no record" report.
 *
 * Budget: a 6s floor for short utterances (unchanged behavior — a 5-word take that hangs 6s
 * IS pathological) plus 0.3x the audio duration, capped at 25s so a stuck request still fails
 * fast enough to fall back while the client's own 60s ceiling stays comfortably clear.
 */
const QWEN_TIMEOUT_FLOOR_MS = 6_000;
const QWEN_TIMEOUT_PER_SECOND_MS = 300;
const QWEN_TIMEOUT_CEILING_MS = 25_000;

/** AAC/MP3 at the client's 32-64kbps; base64 inflates by 4/3. Rough is fine — this only sizes a timeout. */
const APPROX_BYTES_PER_AUDIO_SECOND = 4_000;

export function asrTimeoutMs(audioBase64Length: number): number {
  const seconds = (audioBase64Length * 0.75) / APPROX_BYTES_PER_AUDIO_SECOND;
  // Math.round is LOAD-BEARING: AbortSignal.timeout() throws RangeError on a fractional
  // delay, and that throw lands inside the ASR try/catch — i.e. a float here silently
  // downgrades EVERY quality-tier request to Whisper. Caught by the orchestration
  // integration test the day after this function shipped without it.
  return Math.round(Math.min(QWEN_TIMEOUT_CEILING_MS, QWEN_TIMEOUT_FLOOR_MS + seconds * QWEN_TIMEOUT_PER_SECOND_MS));
}

export interface QwenRegion {
  baseUrl: string;
  model: string;
  apiKey: string | undefined;
}

/**
 * Region-aware model selection layered on the shared DashScope region resolver: the ASR
 * model needs a "-us" suffix in the US region (`qwen3-asr-flash-us`) unlike the rewrite model.
 */
export function resolveQwenRegion(env: Env, continent: string | undefined, preference?: RegionPreference): QwenRegion {
  const { apac, baseUrl, apiKey } = resolveDashscopeRegion(env, continent, preference);
  return {
    baseUrl,
    apiKey,
    model: apac ? (env.QWEN_MODEL_APAC ?? 'qwen3-asr-flash') : (env.QWEN_MODEL_US ?? 'qwen3-asr-flash-us'),
  };
}

interface QwenResponseShape {
  output?: {
    choices?: Array<{
      message?: {
        content?: Array<{ text?: string }>;
      };
    }>;
  };
}

/**
 * Synchronous transcription via DashScope's multimodal-generation endpoint.
 *
 * Context biasing (re-verified 2026-07-19 against the official Qwen-ASR API reference,
 * help.aliyun.com/zh/model-studio/qwen-asr-api-reference): the docs DO document "定制化识别"
 * for this synchronous endpoint — a system message as the FIRST element of `messages`,
 * carrying "背景文本和实体词表" (background text and entity vocabulary), up to 10k tokens.
 * They equally state it does NOT support role-style system prompts, which explains the
 * 2026-07-12 incident: we injected a long free-form instruction paragraph and the model
 * read it back out as the "transcription". This re-enabled version therefore only sends a
 * bare entity list (the client keyword vocabulary, no scaffold sentences, no projectContext),
 * and the caller runs every result through isContextEcho() before trusting it — an echo is
 * treated as a degenerate result and falls back to Whisper.
 * Free-form projectContext stays rewrite-stage-only — see prompts.ts buildRewriteUserMessage.
 */
/** data-URI MIME per supported upload container (protocol v2 `audioFormat`, default mp3). */
const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
};

export async function qwenTranscribe(
  region: QwenRegion,
  audioBase64: string,
  language: string | undefined,
  contextWords: string[] = [],
  audioFormat = 'mp3',
): Promise<string> {
  if (!region.apiKey) {
    throw new EngineError('asr', 'dashscope_not_configured');
  }

  const mime = AUDIO_MIME[audioFormat] ?? AUDIO_MIME['mp3'];
  const context = contextWords.join(', ');
  const res = await fetch(`${region.baseUrl}/api/v1/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${region.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: region.model,
      input: {
        messages: [
          ...(context.length > 0 ? [{ role: 'system', content: [{ text: context }] }] : []),
          { role: 'user', content: [{ audio: `data:${mime};base64,${audioBase64}` }] },
        ],
      },
      parameters: {
        asr_options: {
          ...(language ? { language } : {}),
          enable_itn: true,
        },
      },
    }),
    signal: AbortSignal.timeout(asrTimeoutMs(audioBase64.length)),
  });

  if (!res.ok) {
    throw new EngineError('asr', `dashscope_http_${res.status}`);
  }

  const body = (await res.json()) as QwenResponseShape;
  const text = body.output?.choices?.[0]?.message?.content?.find((c) => typeof c.text === 'string')?.text;
  if (typeof text !== 'string') {
    throw new EngineError('asr', 'dashscope_bad_shape');
  }
  return text.trim();
}
