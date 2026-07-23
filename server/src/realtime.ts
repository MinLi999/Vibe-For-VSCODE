/**
 * Streaming transcription proxy (docs/04-STREAMING.md, Phase B① M1).
 *
 * Client ⇄ this Worker (WS) ⇄ DashScope qwen3-asr-flash-realtime (WS, Singapore intl region).
 * The client streams raw PCM16/16k mono frames (binary); DashScope's server_vad splits
 * utterances; every completed utterance runs through the existing rewrite chain before being
 * sent down as a final segment. Partials are forwarded as-is for status-bar preview only.
 *
 * Secrets (DashScope key, workspace id) never leave this Worker — clients authenticate with
 * their license key exactly like the HTTP path. Quality tier (plan:"pro") only.
 */

import { authenticate } from './auth';
import { qwenRewrite, resolveQwenRewriteRegion } from './engines/qwenRewrite';
import { isNonSpeechTranscript } from './nonspeech';
import { buildRewriteUserMessage, CLEAN_SYSTEM_PROMPT, REWRITE_SYSTEM_PROMPT, withAppTone, withChineseVariant } from './prompts';
import { APP_CATEGORIES } from './types';
import type { AppCategory, ChineseVariant, Env, RewriteMode } from './types';

// ---- Pure protocol helpers (unit-tested in realtime.test.ts) ----

/** Server VAD silence window: clamp the client's preference into DashScope's sane range. */
export function clampSilenceMs(requested: number | undefined): number {
  const DEFAULT = 800;
  if (typeof requested !== 'number' || !Number.isFinite(requested)) {
    return DEFAULT;
  }
  return Math.min(2000, Math.max(400, Math.round(requested)));
}

/**
 * wss URL for the Singapore international realtime endpoint (the only intl region, see docs).
 * With a workspace id we use the per-workspace host Alibaba recommends for stability; without
 * one the legacy shared intl domain still serves the same path, so streaming works with nothing
 * but the DashScope API key configured.
 */
export function realtimeUpstreamUrl(workspaceId: string | undefined, model = 'qwen3-asr-flash-realtime'): string {
  const host = workspaceId && workspaceId.trim().length > 0
    ? `${workspaceId.trim()}.ap-southeast-1.maas.aliyuncs.com`
    : 'dashscope-intl.aliyuncs.com';
  return `wss://${host}/api-ws/v1/realtime?model=${model}`;
}

/** First JSON frame sent upstream: session config with server-side utterance detection. */
export function buildSessionUpdate(opts: { silenceMs: number; language?: string }): Record<string, unknown> {
  return {
    type: 'session.update',
    session: {
      modalities: ['text'],
      input_audio_format: 'pcm',
      sample_rate: 16000,
      // 'auto' (or absence) lets the model self-detect — same policy as the batch path.
      ...(opts.language && opts.language !== 'auto'
        ? { input_audio_transcription: { language: opts.language } }
        : {}),
      turn_detection: { type: 'server_vad', silence_duration_ms: opts.silenceMs },
    },
  };
}

export type UpstreamEvent =
  | { kind: 'partial'; text: string }
  | { kind: 'completed'; text: string }
  | { kind: 'session_finished' }
  | { kind: 'error'; message: string }
  | { kind: 'ignore' };

/** Maps a raw upstream JSON event to our internal classification. Unknown events are ignored. */
export function classifyUpstreamEvent(raw: unknown): UpstreamEvent {
  if (typeof raw !== 'object' || raw === null) {
    return { kind: 'ignore' };
  }
  const evt = raw as Record<string, unknown>;
  const type = typeof evt['type'] === 'string' ? evt['type'] : '';
  if (type === 'conversation.item.input_audio_transcription.completed') {
    return { kind: 'completed', text: typeof evt['transcript'] === 'string' ? evt['transcript'] : '' };
  }
  if (type === 'conversation.item.input_audio_transcription.text') {
    // Partial deltas: DashScope ships the running text under `text` (falling back to `transcript`).
    const text = typeof evt['text'] === 'string' ? evt['text'] : typeof evt['transcript'] === 'string' ? evt['transcript'] : '';
    return { kind: 'partial', text };
  }
  if (type === 'session.finished') {
    return { kind: 'session_finished' };
  }
  if (type === 'error') {
    const message = typeof evt['message'] === 'string' ? evt['message'] : 'upstream error';
    return { kind: 'error', message };
  }
  return { kind: 'ignore' };
}

/** Client → Worker control frames (audio is sent as binary frames, not JSON). */
export interface ClientStartOptions {
  rewriteMode: RewriteMode;
  chineseVariant?: ChineseVariant;
  appCategory?: AppCategory;
  keywords: string[];
  language?: string;
  vadSilenceMs?: number;
}

/** Parses the client's initial {type:"start"} frame with safe defaults; null = malformed. */
export function parseClientStart(raw: unknown): ClientStartOptions | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const msg = raw as Record<string, unknown>;
  if (msg['type'] !== 'start') {
    return null;
  }
  const rewriteMode: RewriteMode = msg['rewriteMode'] === 'off' || msg['rewriteMode'] === 'rewrite' ? msg['rewriteMode'] : 'clean';
  const keywords = Array.isArray(msg['keywords'])
    ? msg['keywords'].filter((k): k is string => typeof k === 'string' && k.trim().length > 0).slice(0, 40)
    : [];
  return {
    rewriteMode,
    chineseVariant: typeof msg['chineseVariant'] === 'string' ? (msg['chineseVariant'] as ChineseVariant) : undefined,
    appCategory: APP_CATEGORIES.includes(msg['appCategory'] as AppCategory) ? (msg['appCategory'] as AppCategory) : undefined,
    keywords,
    language: typeof msg['language'] === 'string' ? msg['language'] : undefined,
    vadSilenceMs: typeof msg['vadSilenceMs'] === 'number' ? msg['vadSilenceMs'] : undefined,
  };
}

// ---- Connection handler ----

const MAX_SESSION_MS = 10 * 60 * 1000; // Mirrors the client-side maxRecordSeconds ceiling (600s).

/**
 * Upgrades /api/realtime. Auth mirrors the HTTP path (Bearer license key); native WebSocket
 * clients that cannot set headers pass the key as the second Sec-WebSocket-Protocol entry
 * ("vibefox.v1, <key>") — never in the URL.
 */
export async function handleRealtime(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response(JSON.stringify({ error: 'Expected a WebSocket upgrade' }), { status: 426 });
  }

  // Subprotocol auth fallback: synthesize the Authorization header the shared authenticator expects.
  const protocols = (request.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map((p) => p.trim());
  let authRequest = request;
  if (!request.headers.get('Authorization') && protocols[0] === 'vibefox.v1' && protocols[1]) {
    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${protocols[1]}`);
    authRequest = new Request(request, { headers });
  }
  const auth = await authenticate(authRequest, env);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.message }), { status: auth.status });
  }
  if (auth.metadata?.plan !== 'pro') {
    return new Response(JSON.stringify({ error: 'Streaming transcription requires a pro plan' }), { status: 403 });
  }
  // Only the API key is mandatory; the workspace id merely upgrades the upstream host.
  if (!env.DASHSCOPE_API_KEY_APAC) {
    return new Response(JSON.stringify({ error: 'Streaming is not configured on this server' }), { status: 503 });
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  void runSession(server, request, env).catch((err) => {
    try {
      server.send(JSON.stringify({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
      server.close(1011, 'session error');
    } catch {
      // Socket already gone.
    }
  });

  const responseInit: ResponseInit & { webSocket: WebSocket } = { status: 101, webSocket: client };
  if (protocols[0] === 'vibefox.v1') {
    responseInit.headers = { 'Sec-WebSocket-Protocol': 'vibefox.v1' };
  }
  return new Response(null, responseInit);
}

/** Drives one streaming session: client start → upstream connect → relay loop. */
async function runSession(downstream: WebSocket, request: Request, env: Env): Promise<void> {
  const workspaceId = env.DASHSCOPE_WORKSPACE_ID;
  const apiKey = env.DASHSCOPE_API_KEY_APAC as string;
  const continent = (request.cf as { continent?: string } | undefined)?.continent;

  // First frame from the client must be the JSON start message with session options.
  const start = await new Promise<ClientStartOptions>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('start frame timeout')), 10_000);
    downstream.addEventListener(
      'message',
      (evt) => {
        clearTimeout(timer);
        try {
          const parsed = typeof evt.data === 'string' ? parseClientStart(JSON.parse(evt.data)) : null;
          if (parsed === null) {
            reject(new Error('first frame must be a {type:"start"} JSON message'));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error('malformed start frame'));
        }
      },
      { once: true },
    );
  });

  // Upstream connect (Workers outbound WS = fetch with an Upgrade header; auth is a header, never the URL).
  const upstreamResp = await fetch(realtimeUpstreamUrl(workspaceId), {
    headers: {
      Upgrade: 'websocket',
      Authorization: `Bearer ${apiKey}`,
      // Scopes the session to a workspace on the legacy shared host; harmless on the per-workspace one.
      ...(workspaceId ? { 'X-DashScope-WorkSpace': workspaceId } : {}),
    },
  });
  const upstream = (upstreamResp as Response & { webSocket: WebSocket | null }).webSocket;
  if (!upstream) {
    throw new Error(`upstream handshake failed (${upstreamResp.status})`);
  }
  upstream.accept();
  upstream.send(JSON.stringify(buildSessionUpdate({ silenceMs: clampSilenceMs(start.vadSilenceMs), language: start.language })));

  const systemPrompt = withAppTone(
    withChineseVariant(start.rewriteMode === 'rewrite' ? REWRITE_SYSTEM_PROMPT : CLEAN_SYSTEM_PROMPT, start.chineseVariant),
    start.appCategory,
  );
  const rewriteRegion = resolveQwenRewriteRegion(env, continent, 'apac');

  // Rewrites run per-utterance but must reach the client in spoken order.
  let deliveryChain: Promise<void> = Promise.resolve();
  const sessionDeadline = setTimeout(() => {
    downstream.send(JSON.stringify({ type: 'error', message: 'session time limit reached' }));
    upstream.close(1000, 'session limit');
    downstream.close(1000, 'session limit');
  }, MAX_SESSION_MS);

  const finalizeSegment = (rawText: string): void => {
    deliveryChain = deliveryChain.then(async () => {
      if (isNonSpeechTranscript(rawText)) {
        return; // Silence/hallucination — never worth a rewrite call or a client event.
      }
      let finalText = rawText;
      let rewriteEngine = 'none';
      if (start.rewriteMode !== 'off' && rawText.trim().length >= 10) {
        try {
          finalText = await qwenRewrite(rewriteRegion, systemPrompt, buildRewriteUserMessage(rawText, start.keywords));
          rewriteEngine = 'qwen-plus';
        } catch {
          finalText = rawText; // Same graceful degradation as the HTTP path.
        }
      }
      downstream.send(JSON.stringify({ type: 'segment', rawText, finalText, rewriteEngine }));
    });
  };

  upstream.addEventListener('message', (evt) => {
    if (typeof evt.data !== 'string') {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(evt.data);
    } catch {
      return;
    }
    const event = classifyUpstreamEvent(parsed);
    switch (event.kind) {
      case 'partial':
        downstream.send(JSON.stringify({ type: 'partial', text: event.text }));
        break;
      case 'completed':
        finalizeSegment(event.text);
        break;
      case 'session_finished':
        void deliveryChain.then(() => {
          clearTimeout(sessionDeadline);
          downstream.send(JSON.stringify({ type: 'done' }));
          downstream.close(1000, 'finished');
        });
        break;
      case 'error':
        clearTimeout(sessionDeadline);
        downstream.send(JSON.stringify({ type: 'error', message: event.message }));
        downstream.close(1011, 'upstream error');
        break;
      case 'ignore':
        break;
    }
  });

  upstream.addEventListener('close', () => {
    clearTimeout(sessionDeadline);
    try {
      downstream.close(1000, 'upstream closed');
    } catch {
      // Already closed.
    }
  });

  downstream.addEventListener('message', (evt) => {
    if (typeof evt.data === 'string') {
      try {
        const msg = JSON.parse(evt.data) as { type?: string };
        if (msg.type === 'finish') {
          upstream.send(JSON.stringify({ type: 'session.finish' }));
        }
      } catch {
        // Ignore malformed control frames.
      }
      return;
    }
    // Binary frame = raw PCM16 chunk; upstream expects base64 in a JSON envelope.
    const bytes = new Uint8Array(evt.data as ArrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    upstream.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: btoa(binary) }));
  });

  downstream.addEventListener('close', () => {
    clearTimeout(sessionDeadline);
    try {
      upstream.close(1000, 'client closed');
    } catch {
      // Already closed.
    }
  });

  downstream.send(JSON.stringify({ type: 'ready' }));
}
