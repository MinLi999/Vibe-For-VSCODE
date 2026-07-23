import { EngineError } from '../errors';
import type { Env, RegionPreference } from '../types';
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
export async function qwenTranscribe(
  region: QwenRegion,
  audioBase64: string,
  language: string | undefined,
  contextWords: string[] = [],
): Promise<string> {
  if (!region.apiKey) {
    throw new EngineError('asr', 'dashscope_not_configured');
  }

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
          { role: 'user', content: [{ audio: `data:audio/mpeg;base64,${audioBase64}` }] },
        ],
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
