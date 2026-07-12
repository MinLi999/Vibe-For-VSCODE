import { EngineError } from '../errors';
import type { Env } from '../types';

export const HAIKU_MODEL = 'claude-haiku-4-5';
const ANTHROPIC_TIMEOUT_MS = 10_000;

interface AnthropicResponseShape {
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
}

/**
 * Rewrite via Claude Haiku 4.5 (Anthropic Messages API, non-streaming — typical output
 * is ~100 tokens, so streaming buys nothing for the "insert whole utterance" product shape).
 */
export async function haikuRewrite(env: Env, systemPrompt: string, userContent: string): Promise<string> {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new EngineError('rewrite', 'anthropic_not_configured');
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      // Sized ~3x the input so truncation is practically impossible (the prompt caps output
      // at the input's length); stop_reason is still checked below as a backstop.
      max_tokens: Math.min(8192, Math.max(512, userContent.length * 3)),
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
    signal: AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new EngineError('rewrite', `anthropic_http_${res.status}`);
  }

  const body = (await res.json()) as AnthropicResponseShape;
  if (body.stop_reason === 'max_tokens') {
    throw new EngineError('rewrite', 'anthropic_truncated');
  }
  const text = body.content?.find((b) => b.type === 'text')?.text?.trim();
  if (typeof text !== 'string') {
    throw new EngineError('rewrite', 'anthropic_empty');
  }
  return text;
}
