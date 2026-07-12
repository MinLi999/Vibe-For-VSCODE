import { authenticate } from './auth';
import { enforceRateLimit } from './ratelimit';
import { handleTranscribe, HttpError } from './transcribe';
import type { Env, ErrorResponseBody, Tier } from './types';

/** Unified CORS headers (the extension calls via Node fetch and isn't actually CORS-bound; kept for a future web client). */
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

function errorResponse(status: number, message: string): Response {
  const body: ErrorResponseBody = { error: message };
  return json(body, status);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Top-level catch-all: any uncaught exception → unified 500 JSON, no stack leakage.
    try {
      const url = new URL(request.url);

      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      if (url.pathname !== '/api/transcribe') {
        return errorResponse(404, 'Not found');
      }
      if (request.method !== 'POST') {
        return errorResponse(405, 'Method not allowed, use POST');
      }

      const auth = await authenticate(request, env);
      if (!auth.ok) {
        return errorResponse(auth.status, auth.message);
      }

      const tier: Tier = auth.metadata?.plan === 'pro' ? 'quality' : 'free';
      await enforceRateLimit(env, tier, auth.key);

      const result = await handleTranscribe(request, env, auth);
      // Structured, content-free log line: engines/timings/fallback only, never transcript text.
      console.log(
        `transcribe ok owner=${auth.metadata?.owner ?? 'unknown'} tier=${result.tier}` +
          ` asr=${result.engines.asr} rewrite=${result.engines.rewrite}` +
          ` chars=${result.finalText.length} asr_ms=${result.timings.asr_ms} rewrite_ms=${result.timings.rewrite_ms}` +
          (result.fallback ? ` fallback=${JSON.stringify(result.fallback)}` : ''),
      );
      return json(result, 200);
    } catch (err) {
      if (err instanceof HttpError) {
        return errorResponse(err.status, err.message);
      }
      console.error('unhandled error', err);
      return errorResponse(500, 'Internal server error');
    }
  },
} satisfies ExportedHandler<Env>;
