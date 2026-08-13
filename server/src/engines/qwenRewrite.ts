import { EngineError } from '../errors';
import type { Env, RegionPreference } from '../types';
import { resolveDashscopeRegion } from './dashscopeRegion';

const QWEN_REWRITE_TIMEOUT_MS = 8_000;
const DEFAULT_MODEL = 'qwen-plus';

export interface QwenRewriteRegion {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
}

/**
 * Same region routing as ASR (shared resolver), but qwen-plus needs no "-us" region suffix
 * (unlike qwen3-asr-flash) — it's the same model id in both regions.
 */
export function resolveQwenRewriteRegion(env: Env, continent: string | undefined, preference?: RegionPreference): QwenRewriteRegion {
  const { baseUrl, apiKey } = resolveDashscopeRegion(env, continent, preference);
  return { baseUrl, apiKey, model: env.QWEN_REWRITE_MODEL ?? DEFAULT_MODEL };
}

interface QwenTextGenResponseShape {
  output?: { choices?: Array<{ message?: { content?: string } }> };
  /**
   * DashScope reports how much of the prompt was served from its implicit context cache.
   * We surface it because ~88% of every rewrite request is the fixed prompt prefix, billed at
   * 20% when cached — so cache_hit is effectively a live cost gauge. A silent drop to zero
   * (e.g. someone puts varying content ahead of the stable prefix) would otherwise be
   * invisible until the invoice arrives. See prompts.ts buildRewriteUserMessage.
   */
  usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

/** Cache telemetry for one rewrite call; content-free, safe to log. */
export interface RewriteUsage {
  inputTokens: number;
  cachedTokens: number;
}

/** Populated by the most recent qwenRewrite call for the caller's log line. */
export let lastRewriteUsage: RewriteUsage | undefined;

/**
 * Rewrite via Qwen-Plus (DashScope native text-generation) — the sole quality-tier rewrite
 * engine (~3-4x cheaper than the LLM it replaced at comparable quality on Chinese/EN-mixed
 * dictation, and reuses the region-locked DashScope keys already required for ASR).
 * cf-llama is the free-tier engine and the edge fallback when Qwen-Plus is unavailable.
 */
export async function qwenRewrite(region: QwenRewriteRegion, systemPrompt: string, userContent: string): Promise<string> {
  if (!region.apiKey) {
    throw new EngineError('rewrite', 'qwen_rewrite_not_configured');
  }

  const res = await fetch(`${region.baseUrl}/api/v1/services/aigc/text-generation/generation`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${region.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: region.model,
      input: {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      },
      parameters: { result_format: 'message', temperature: 0 },
    }),
    signal: AbortSignal.timeout(QWEN_REWRITE_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new EngineError('rewrite', `qwen_rewrite_http_${res.status}`);
  }

  const body = (await res.json()) as QwenTextGenResponseShape;
  lastRewriteUsage = {
    inputTokens: body.usage?.input_tokens ?? 0,
    cachedTokens: body.usage?.prompt_tokens_details?.cached_tokens ?? 0,
  };
  const text = body.output?.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new EngineError('rewrite', 'qwen_rewrite_empty');
  }
  return text;
}
