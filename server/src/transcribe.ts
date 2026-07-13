import type { AuthResult } from './auth';
import { haikuRewrite, HAIKU_MODEL } from './engines/anthropicRewrite';
import { llamaRewrite } from './engines/cfLlama';
import { whisperTranscribe } from './engines/cfWhisper';
import { qwenTranscribe, resolveQwenRegion } from './engines/qwenAsr';
import { qwenRewrite, resolveQwenRewriteRegion } from './engines/qwenRewrite';
import { HttpError, toReasonCode } from './errors';
import { isNonSpeechTranscript } from './nonspeech';
import { buildRewriteUserMessage, CLEAN_SYSTEM_PROMPT, REWRITE_SYSTEM_PROMPT } from './prompts';
import type {
  Env,
  RewriteMode,
  Tier,
  TranscribeRequestBody,
  TranscribeResponseBody,
} from './types';

/** Payload ceilings per tier (base64 chars). Quality stays within DashScope's 10MB data-URI cap. */
const MAX_AUDIO_BASE64_QUALITY = 8 * 1024 * 1024;
const MAX_AUDIO_BASE64_FREE = 4 * 1024 * 1024;

/** UTF-8 byte budget for the Whisper initial_prompt (prev-transcript + scaffold + keywords). */
const WHISPER_PROMPT_BUDGET_BYTES = 800;

const MAX_KEYWORDS = 40;
const MAX_KEYWORD_LENGTH = 64;
const MAX_PROJECT_CONTEXT_CHARS = 8000;
/** Rewriting a near-empty utterance wastes 0.5-2s of latency for nothing. */
const MIN_REWRITE_CHARS = 10;

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const LANGUAGE_PATTERN = /^[a-z]{2}$/;
const REWRITE_MODES: readonly RewriteMode[] = ['off', 'clean', 'rewrite'];

/**
 * Assembles the client's keyword list into Whisper's initial_prompt:
 * a Chinese scene-setting sentence + comma-separated vocabulary. Whisper treats this as
 * preceding context, biasing similar-sounding speech toward these code identifiers
 * (preventing variable names from being transcribed as phonetically-similar Chinese characters).
 * Only used on the Whisper path — Qwen3-ASR gets the far roomier context channel instead.
 */
export function buildInitialPrompt(keywords: string[], previousTranscript?: string): string | undefined {
  let promptVal = '';
  if (previousTranscript && previousTranscript.trim().length > 0) {
    promptVal += previousTranscript.trim().slice(-300) + '。';
  }

  if (keywords.length > 0) {
    const prefix = '好的，我现在打开了项目。刚才看了一下代码，里面用到了 ';
    const suffix = ' 这些。现在我要开始说一下修改思路。';
    const encoder = new TextEncoder();
    let keywordsPart = '';
    for (let i = 0; i < keywords.length; i++) {
      const sep = i === 0 ? '' : '、';
      const part = sep + keywords[i];
      if (encoder.encode(promptVal + prefix + keywordsPart + part + suffix).length > WHISPER_PROMPT_BUDGET_BYTES) {
        break;
      }
      keywordsPart += part;
    }
    if (keywordsPart.length > 0) {
      promptVal += prefix + keywordsPart + suffix;
    }
  }

  return promptVal.length > 0 ? promptVal : undefined;
}

interface ParsedRequest {
  audio: string;
  language: string;
  keywords: string[];
  projectContext?: string;
  previousTranscript?: string;
  rewriteMode: RewriteMode;
  enginePreference: 'auto' | 'cloudflare';
  compareRewrite: boolean;
}

/**
 * Validates and normalizes the request body; throws HttpError directly if invalid.
 * v1/v2 compatible: `rewriteMode` marks a v2 request; a v1 `llmCorrect: true` maps to 'clean'.
 * v1 `llmPrompt`/`llmModel` are deliberately IGNORED — prompts/models are server-owned.
 */
export function parseRequestBody(raw: unknown, maxAudioBase64: number): ParsedRequest {
  if (typeof raw !== 'object' || raw === null) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  const body = raw as Record<string, unknown>;

  const audio = body['audio'];
  if (typeof audio !== 'string' || audio.length === 0) {
    throw new HttpError(400, 'Field "audio" (base64 string) is required');
  }
  if (audio.length > maxAudioBase64) {
    throw new HttpError(413, `Audio payload too large (>${maxAudioBase64} base64 chars); keep recordings under the client limit`);
  }
  if (!BASE64_PATTERN.test(audio)) {
    throw new HttpError(400, 'Field "audio" is not valid base64');
  }

  let language = 'zh';
  if (body['language'] !== undefined) {
    if (typeof body['language'] !== 'string' || !LANGUAGE_PATTERN.test(body['language'])) {
      throw new HttpError(400, 'Field "language" must be a two-letter ISO-639-1 code');
    }
    language = body['language'];
  }

  let keywords: string[] = [];
  if (body['keywords'] !== undefined) {
    if (!Array.isArray(body['keywords'])) {
      throw new HttpError(400, 'Field "keywords" must be an array of strings');
    }
    keywords = body['keywords']
      .filter((k): k is string => typeof k === 'string')
      .map((k) => k.trim())
      .filter((k) => k.length > 0 && k.length <= MAX_KEYWORD_LENGTH)
      .slice(0, MAX_KEYWORDS);
  }

  let projectContext: string | undefined;
  if (body['projectContext'] !== undefined) {
    if (typeof body['projectContext'] !== 'string') {
      throw new HttpError(400, 'Field "projectContext" must be a string');
    }
    projectContext = body['projectContext'].slice(0, MAX_PROJECT_CONTEXT_CHARS);
  }

  const previousTranscript = typeof body['previousTranscript'] === 'string' ? body['previousTranscript'] : undefined;

  let rewriteMode: RewriteMode;
  if (body['rewriteMode'] !== undefined) {
    if (typeof body['rewriteMode'] !== 'string' || !REWRITE_MODES.includes(body['rewriteMode'] as RewriteMode)) {
      throw new HttpError(400, 'Field "rewriteMode" must be one of "off" | "clean" | "rewrite"');
    }
    rewriteMode = body['rewriteMode'] as RewriteMode;
  } else {
    // v1 request: llmCorrect:true meant "run the correction pass", which is today's 'clean'.
    rewriteMode = body['llmCorrect'] === true ? 'clean' : 'off';
  }

  const enginePreference = body['enginePreference'] === 'cloudflare' ? 'cloudflare' : 'auto';
  const compareRewrite = body['compareRewrite'] === true;

  return { audio, language, keywords, projectContext, previousTranscript, rewriteMode, enginePreference, compareRewrite };
}

/** Core handler: validate → tier routing → ASR chain → rewrite chain → assemble v2 response. */
export async function handleTranscribe(request: Request, env: Env, auth: AuthResult & { ok: true }): Promise<TranscribeResponseBody> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }

  const tier: Tier = auth.metadata?.plan === 'pro' ? 'quality' : 'free';
  const body = parseRequestBody(raw, tier === 'quality' ? MAX_AUDIO_BASE64_QUALITY : MAX_AUDIO_BASE64_FREE);

  const fallback: { asr?: string; rewrite?: string } = {};
  const started = Date.now();
  const continent = (request.cf as { continent?: string } | undefined)?.continent;

  // --- ASR stage: Qwen3-ASR (quality tier, region-aware) with Cloudflare Whisper fallback ---
  // API keys are region-locked (a Singapore key 403s against the US endpoint), so the resolved
  // region carries its own key; missing key for THIS user's region falls straight to Whisper.
  let rawText = '';
  let asrEngine: TranscribeResponseBody['engines']['asr'] = 'cf-whisper-large-v3-turbo';

  if (tier === 'quality' && body.enginePreference !== 'cloudflare') {
    const region = resolveQwenRegion(env, continent);
    if (region.apiKey) {
      try {
        rawText = await qwenTranscribe(region, body.audio, body.language);
        asrEngine = 'qwen3-asr-flash';
      } catch (err) {
        fallback.asr = toReasonCode(err, 'dashscope');
      }
    }
  }
  if (asrEngine !== 'qwen3-asr-flash') {
    rawText = await whisperTranscribe(env, body.audio, body.language, buildInitialPrompt(body.keywords, body.previousTranscript));
  }
  const asrMs = Date.now() - started;

  // Empty AND hallucinated non-speech ("...", "(音频中充斥着机械噪音…)") both count as "no speech":
  // skipping the rewrite stage saves its cost, and the 502 message keeps the exact substrings
  // ("no text"/"silent") the client's silent-skip matcher looks for.
  if (rawText.length === 0 || isNonSpeechTranscript(rawText)) {
    throw new HttpError(502, 'Transcription produced no text (silent or non-speech audio)');
  }

  // --- Rewrite stage: Haiku 4.5 (quality tier) → cf llama → raw text ---
  // Never changes what gets returned as finalText/inserted by the client.
  let finalText = rawText;
  let rewriteEngine: TranscribeResponseBody['engines']['rewrite'] = 'none';
  const rewriteStarted = Date.now();

  // --- Shadow comparison: Qwen-Plus rewrite, run CONCURRENTLY with the primary chain so the
  // evaluation adds ~0 sequential latency (bounded by whichever engine is slower). Never used
  // as finalText — evaluation-only signal reported in `rewriteComparison` (see the "why Claude
  // vs Alibaba's own model" discussion this round: cheaper Qwen-Plus reuses the same DashScope
  // key/region already required for ASR, so this is a free-to-wire A/B, not a new dependency.
  let rewriteComparison: TranscribeResponseBody['rewriteComparison'];

  if (body.rewriteMode !== 'off' && rawText.trim().length >= MIN_REWRITE_CHARS) {
    const systemPrompt = body.rewriteMode === 'rewrite' ? REWRITE_SYSTEM_PROMPT : CLEAN_SYSTEM_PROMPT;
    const userMessage = buildRewriteUserMessage(rawText, body.keywords, body.previousTranscript, body.projectContext);

    const primaryRewrite = (async () => {
      if (tier === 'quality' && env.ANTHROPIC_API_KEY) {
        try {
          finalText = await haikuRewrite(env, systemPrompt, userMessage);
          rewriteEngine = HAIKU_MODEL;
          return;
        } catch (err) {
          fallback.rewrite = toReasonCode(err, 'anthropic');
        }
      }
      try {
        finalText = await llamaRewrite(env, systemPrompt, userMessage);
        rewriteEngine = 'cf-llama-3.1-8b-instruct';
      } catch (err) {
        // Graceful degradation: keep the raw transcription rather than failing the request.
        fallback.rewrite = fallback.rewrite ?? toReasonCode(err, 'cf_llama');
        finalText = rawText;
      }
    })();

    const shadowQwenRewrite =
      tier === 'quality' && body.compareRewrite
        ? (async () => {
            const region = resolveQwenRewriteRegion(env, continent);
            const qwenStarted = Date.now();
            try {
              const text = await qwenRewrite(region, systemPrompt, userMessage);
              rewriteComparison = { qwenText: text, qwenMs: Date.now() - qwenStarted };
            } catch (err) {
              rewriteComparison = { qwenError: toReasonCode(err, 'qwen_rewrite'), qwenMs: Date.now() - qwenStarted };
            }
          })()
        : Promise.resolve();

    await Promise.all([primaryRewrite, shadowQwenRewrite]);
  }
  const rewriteMs = Date.now() - rewriteStarted;
  const totalMs = Date.now() - started;

  return {
    text: finalText,
    duration_ms: totalMs,
    rawText,
    finalText,
    tier,
    engines: { asr: asrEngine, rewrite: rewriteEngine },
    timings: { asr_ms: asrMs, rewrite_ms: rewriteMs, total_ms: totalMs },
    ...(fallback.asr || fallback.rewrite ? { fallback } : {}),
    ...(rewriteComparison ? { rewriteComparison } : {}),
  };
}

// Re-exported so index.ts keeps a single import site for handler + error type.
export { HttpError } from './errors';
