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
}

/**
 * Rewrite via Qwen-Plus (DashScope native text-generation) — the PRIMARY quality-tier rewrite
 * engine (user decision after a multi-day Haiku-vs-Qwen comparison: ~3-4x cheaper at
 * comparable quality, reuses the region-locked DashScope keys already required for ASR).
 * Haiku 4.5 remains the first fallback and the compare-mode shadow engine.
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
  const text = body.output?.choices?.[0]?.message?.content?.trim();
  if (!text) {
    throw new EngineError('rewrite', 'qwen_rewrite_empty');
  }
  return text;
}
