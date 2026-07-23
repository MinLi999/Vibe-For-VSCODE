/**
 * Cross-service contract: fields must stay in sync with client/src/services/CloudflareApiService.ts.
 */

/** Minimal shape of Cloudflare's Rate Limiting binding (unsafe binding, not in generated types). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  /** Workers AI binding (wrangler.jsonc → "ai".binding). */
  AI: Ai;
  /** KV for license key existence checks (key = license key, value = metadata JSON). */
  AUTH_KEYS: KVNamespace;
  /**
   * DashScope (Alibaba Cloud Model Studio) API keys — REGION-LOCKED, each region needs its own
   * key (a Singapore-region key 403s against the US endpoint and vice versa):
   * `wrangler secret put DASHSCOPE_API_KEY_APAC` / `wrangler secret put DASHSCOPE_API_KEY_US`.
   */
  DASHSCOPE_API_KEY_APAC?: string;
  DASHSCOPE_API_KEY_US?: string;
  /**
   * Model Studio workspace id for the realtime WebSocket endpoint (it is part of the
   * hostname: wss://{id}.ap-southeast-1.maas.aliyuncs.com). Singapore only — the
   * international realtime endpoint has no US region (docs/04-STREAMING.md).
   * `wrangler secret put DASHSCOPE_WORKSPACE_ID`.
   */
  DASHSCOPE_WORKSPACE_ID?: string;
  /** Region-aware DashScope endpoints/models (wrangler.jsonc vars; see resolveQwenRegion). */
  DASHSCOPE_BASE_URL_APAC?: string;
  DASHSCOPE_BASE_URL_US?: string;
  QWEN_MODEL_APAC?: string;
  QWEN_MODEL_US?: string;
  /** Rewrite-comparison evaluation model (no region suffix needed, unlike the ASR model). */
  QWEN_REWRITE_MODEL?: string;
  /** Per-license-key rate limiters (wrangler.jsonc unsafe bindings; optional so local dev works without them). */
  RL_FREE?: RateLimiter;
  RL_PRO?: RateLimiter;
}

export type RewriteMode = 'off' | 'clean' | 'rewrite';
export type Tier = 'quality' | 'free';
export type AsrEngine = 'qwen3-asr-flash' | 'cf-whisper-large-v3-turbo';
/** Rewrite chain: qwen-plus (quality) → cf-llama (free tier + edge fallback) → raw text. */
export type RewriteEngine = 'qwen-plus' | 'cf-llama-3.1-8b-instruct' | 'none';
/** Output Chinese variant: script + regional idiom, applied by the rewrite stage. */
export type ChineseVariant = 'simplified-cn' | 'simplified-sg-my' | 'traditional-tw' | 'traditional-hk-mo';
/** Manual DashScope region override; 'auto' = continent-based routing (request.cf.continent). */
export type RegionPreference = 'auto' | 'apac' | 'us';

/**
 * Category of the app the text will be pasted into (desktop frontend sends it from the
 * frontmost app's bundle id). The rewrite stage adapts punctuation/formality per category
 * without ever overriding the core no-content-change rules.
 */
export const APP_CATEGORIES = ['ide', 'terminal', 'chat', 'email', 'notes', 'other'] as const;
export type AppCategory = (typeof APP_CATEGORIES)[number];

/**
 * POST /api/transcribe request body.
 * v2 is detected by the presence of `rewriteMode`. v1 fields (`llmCorrect`) are still honored
 * (`llmCorrect: true` maps to `rewriteMode: 'clean'`); v1 `llmPrompt`/`llmModel` are parsed but
 * IGNORED — prompts and model ids are server-owned (billing-abuse hardening).
 */
export interface TranscribeRequestBody {
  /** Base64-encoded MP3 (16kHz mono, compressed client-side). */
  audio: string;
  /**
   * "auto" (v2 client default) or ISO-639-1. 'auto' lets Qwen3-ASR self-detect (official
   * recommendation for mixed zh/en audio); the Whisper fallback still receives an explicit
   * 'zh' lock. Absent field keeps the historical default 'zh'.
   */
  language?: string;
  /** Ranked code identifiers extracted by the client (variable names / filenames). */
  keywords?: string[];
  /** Free-form project context (file summary, tech stack, identifiers with original casing), ≤8000 chars. */
  projectContext?: string;
  /** Tail of the session's already-transcribed text, for cross-segment conditioning. */
  previousTranscript?: string;
  /** v2 rewrite behavior; absence of this field means a v1 request. */
  rewriteMode?: RewriteMode;
  /** Pro users may force the Cloudflare-edge engine chain (debug / network detours). Ignored for free tier. */
  enginePreference?: 'auto' | 'cloudflare';
  /** v1 compatibility (maps to rewriteMode 'clean' when true). */
  llmCorrect?: boolean;
  /** Output Chinese script/idiom variant (applied by the rewrite stage; default simplified-cn). */
  chineseVariant?: ChineseVariant;
  /** Manual DashScope region override (default 'auto' = continent-based). */
  regionPreference?: RegionPreference;
  /** Diagnostic only: client-measured peak PCM amplitude of the captured audio (logged on no-speech). */
  capturePeak?: number;
  /** Paste-target app category (desktop frontend); unknown values are ignored. */
  appCategory?: AppCategory;
}

/** Success response — a strict superset of v1 (`text`/`duration_ms` keep their v1 semantics). */
export interface TranscribeResponseBody {
  /** = finalText (v1 compatibility). */
  text: string;
  /** = timings.total_ms (v1 compatibility). */
  duration_ms: number;
  /** Raw ASR output before any rewrite. */
  rawText: string;
  /** Rewritten output (equals rawText when rewrite is off/skipped). */
  finalText: string;
  tier: Tier;
  engines: { asr: AsrEngine; rewrite: RewriteEngine };
  timings: { asr_ms: number; rewrite_ms: number; total_ms: number };
  /** Downgrade reason codes when an engine fell back, e.g. "dashscope_timeout", "qwen_rewrite_http_429". */
  fallback?: { asr?: string; rewrite?: string };
}

/** Error response (unified shape for all non-2xx). */
export interface ErrorResponseBody {
  error: string;
}

/** Shape of the KV value's metadata. `plan: "pro"` routes to the quality tier. */
export interface LicenseMetadata {
  owner?: string;
  plan?: 'free' | 'pro' | string;
}

/** whisper-large-v3-turbo input (JSON shape). */
export interface WhisperTurboInput {
  audio: string;
  task?: 'transcribe' | 'translate';
  language?: string;
  vad_filter?: boolean;
  initial_prompt?: string;
  /** Deterministic decoding (0 disables sampling randomness). */
  temperature?: number;
}

/** whisper-large-v3-turbo output (only the fields this service consumes). */
export interface WhisperTurboOutput {
  text?: string;
  transcription_info?: {
    language?: string;
    duration?: number;
  };
}
