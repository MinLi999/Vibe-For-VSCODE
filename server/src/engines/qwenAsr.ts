import { EngineError } from '../errors';
import type { Env } from '../types';
import { resolveDashscopeRegion } from './dashscopeRegion';

/**
 * Qwen3-ASR normally answers a 10s utterance in 1-2s; 6s is already pathological, so we cut
 * over to the Cloudflare-edge Whisper fallback instead of keeping the user staring at a
 * spinner (the fallback chain is what "the app froze for 10+ seconds" reports came from).
 */
const QWEN_TIMEOUT_MS = 6_000;

export interface QwenRegion {
  baseUrl: string;
  model: string;
  apiKey: string | undefined;
}

/**
 * Region-aware model selection layered on the shared DashScope region resolver: the ASR
 * model needs a "-us" suffix in the US region (`qwen3-asr-flash-us`) unlike the rewrite model.
 */
export function resolveQwenRegion(env: Env, continent: string | undefined): QwenRegion {
  const { apac, baseUrl, apiKey } = resolveDashscopeRegion(env, continent);
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
 * NOTE: an earlier version of this function also sent a `{ role: 'system', content: [...] }`
 * message carrying a free-form "context enhancement" corpus (project vocabulary/background),
 * based on an unofficial third-party summary. Alibaba's actual API reference does NOT document
 * that mechanism for this synchronous endpoint — the only hint of a context parameter anywhere
 * in the official docs is a commented-out `parameters.corpus.text` field on a DIFFERENT
 * (async file-transcription) endpoint/model. In production, that system message was observed
 * being echoed back verbatim as the "transcription" (the model treated it as conversational
 * content to read out, not as silent bias) — a real prompt-injection-style contamination bug.
 * Fixed by sending audio-only requests here; vocabulary/identifier correction now happens
 * exclusively in the (verified-safe) text rewrite stage — see prompts.ts buildRewriteUserMessage.
 */
export async function qwenTranscribe(region: QwenRegion, audioBase64: string, language: string | undefined): Promise<string> {
  if (!region.apiKey) {
    throw new EngineError('asr', 'dashscope_not_configured');
  }

  const res = await fetch(`${region.baseUrl}/api/v1/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${region.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: region.model,
      input: {
        messages: [{ role: 'user', content: [{ audio: `data:audio/mpeg;base64,${audioBase64}` }] }],
      },
      parameters: {
        asr_options: {
          ...(language ? { language } : {}),
          enable_itn: true,
        },
      },
    }),
    signal: AbortSignal.timeout(QWEN_TIMEOUT_MS),
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
