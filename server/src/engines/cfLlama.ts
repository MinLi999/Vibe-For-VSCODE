import { EngineError } from '../errors';
import type { Env } from '../types';

const LLAMA_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const LLAMA_TIMEOUT_MS = 10_000;

interface LlamaOutputShape {
  response?: string;
  text?: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new EngineError('rewrite', code)), ms)),
  ]);
}

/** Cloudflare-edge llama rewrite (free tier + fallback when Anthropic is unavailable). */
export async function llamaRewrite(env: Env, systemPrompt: string, userContent: string): Promise<string> {
  const result = (await withTimeout(
    env.AI.run(
      LLAMA_MODEL as Parameters<Ai['run']>[0],
      {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        temperature: 0,
        max_tokens: Math.min(4096, Math.max(512, userContent.length * 3)),
      } as unknown as Parameters<Ai['run']>[1],
    ),
    LLAMA_TIMEOUT_MS,
    'cf_llama_timeout',
  )) as LlamaOutputShape;

  const text = (result?.response ?? result?.text)?.trim();
  if (typeof text !== 'string') {
    throw new EngineError('rewrite', 'cf_llama_empty');
  }
  return text;
}
