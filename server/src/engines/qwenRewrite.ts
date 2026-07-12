import { EngineError } from '../errors';
import type { Env } from '../types';
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
export function resolveQwenRewriteRegion(env: Env, continent: string | undefined): QwenRewriteRegion {
  const { baseUrl, apiKey } = resolveDashscopeRegion(env, continent);
  return { baseUrl, apiKey, model: env.QWEN_REWRITE_MODEL ?? DEFAULT_MODEL };
}

interface QwenTextGenResponseShape {
  output?: { choices?: Array<{ message?: { content?: string } }> };
}

/**
 * Rewrite via Qwen-Plus (DashScope native text-generation) — evaluation/shadow engine run
 * alongside Haiku 4.5 during the Haiku-vs-Qwen comparison period; never the inserted text.
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
