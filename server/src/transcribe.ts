import type { AuthResult } from './auth';
import { haikuRewrite, HAIKU_MODEL } from './engines/anthropicRewrite';
import { llamaRewrite } from './engines/cfLlama';
import { whisperTranscribe } from './engines/cfWhisper';
import { qwenTranscribe, resolveQwenRegion } from './engines/qwenAsr';
import { qwenRewrite, resolveQwenRewriteRegion } from './engines/qwenRewrite';
import { HttpError, toReasonCode } from './errors';
import { isNonSpeechTranscript } from './nonspeech';
import { buildRewriteUserMessage, CLEAN_SYSTEM_PROMPT, REWRITE_SYSTEM_PROMPT, withChineseVariant } from './prompts';
import type {
  ChineseVariant,
  Env,
  RegionPreference,
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
const CHINESE_VARIANTS: readonly ChineseVariant[] = ['simplified-cn', 'simplified-sg-my', 'traditional-tw', 'traditional-hk-mo'];
const REGION_PREFERENCES: readonly RegionPreference[] = ['auto', 'apac', 'us'];

/**
 * Assembles the client's keyword list into Whisper's initial_prompt:
 * a Chinese scene-setting sentence + comma-separated vocabulary. Whisper treats this as
 * preceding context, biasing similar-sounding speech toward these code identifiers
 * (preventing variable names from being transcribed as phonetically-similar Chinese characters).
 * previousTranscript is deliberately NOT included: Whisper echoes its prompt back verbatim on
 * near-silent audio, which duplicated already-inserted sentences in the user's chat.
 */
export function buildInitialPrompt(keywords: string[]): string | undefined {
  let promptVal = '';
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
  chineseVariant: ChineseVariant;
  regionPreference: RegionPreference;
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
  // Unknown values silently fall back to the defaults (forward compat with newer clients).
  const chineseVariant = CHINESE_VARIANTS.includes(body['chineseVariant'] as ChineseVariant)
    ? (body['chineseVariant'] as ChineseVariant)
    : 'simplified-cn';
  const regionPreference = REGION_PREFERENCES.includes(body['regionPreference'] as RegionPreference)
    ? (body['regionPreference'] as RegionPreference)
    : 'auto';

  return {
    audio,
    language,
    keywords,
    projectContext,
    previousTranscript,
    rewriteMode,
    enginePreference,
    compareRewrite,
    chineseVariant,
    regionPreference,
  };
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
    const region = resolveQwenRegion(env, continent, body.regionPreference);
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
    rawText = await whisperTranscribe(env, body.audio, body.language, buildInitialPrompt(body.keywords));
  }
  const asrMs = Date.now() - started;

  // Empty AND hallucinated non-speech ("...", "(音频中充斥着机械噪音…)") both count as "no speech":
  // skipping the rewrite stage saves its cost, and the 502 message keeps the exact substrings
  // ("no text"/"silent") the client's silent-skip matcher looks for.
  if (rawText.length === 0 || isNonSpeechTranscript(rawText)) {
    // This 502 branch previously logged NOTHING (only the success path and truly-uncaught
    // exceptions did) — wrangler tail's "Ok"/"Error" badge reflects whether the Worker threw an
    // UNCAUGHT exception, not the HTTP status code, so a clean 502 Response looked identical to
    // a success in the tail output. Content-free diagnostic so intermittent "未识别到语音"
    // reports are actually debuggable instead of invisible.
    console.log(
      `transcribe no_speech owner=${auth.metadata?.owner ?? 'unknown'} tier=${tier}` +
        ` asr=${asrEngine} asr_ms=${asrMs} raw_len=${rawText.length}` +
        ` filtered=${rawText.length > 0 && isNonSpeechTranscript(rawText)}` +
        // Tiny base64 length = the client genuinely captured almost no audio (real capture bug);
        // a normal-sized payload that both engines still read as silent points at content, not
        // transport — distinguishes "nothing was recorded" from "recorded audio was silent".
        ` audio_b64_len=${body.audio.length}` +
        (fallback.asr ? ` asr_fallback=${fallback.asr}` : ''),
    );
    throw new HttpError(502, 'Transcription produced no text (silent or non-speech audio)');
  }

  // --- Rewrite stage (quality tier): Qwen-Plus → Haiku 4.5 → cf llama → raw text ---
  // Qwen-Plus is primary by user decision after a multi-day side-by-side comparison:
  // ~3-4x cheaper at comparable quality, and it reuses the region-locked DashScope keys the
  // ASR stage already requires. Haiku stays as first fallback and as the compare-mode shadow.
  let finalText = rawText;
  let rewriteEngine: TranscribeResponseBody['engines']['rewrite'] = 'none';
  // Own timer per branch (NOT Date.now() - outer-start): the primary and shadow rewrites run
  // concurrently via Promise.all below, so a single outer timer would report whichever engine
  // is SLOWER for both — comparison timings need each engine's own isolated latency.
  let primaryMs = 0;

  // Shadow comparison: run the ALTERNATIVE engine (Haiku) concurrently with the primary chain
  // so the evaluation adds ~0 sequential latency. Never used as finalText — evaluation-only
  // signal reported in `rewriteComparison`.
  let rewriteComparison: TranscribeResponseBody['rewriteComparison'];

  if (body.rewriteMode !== 'off' && rawText.trim().length >= MIN_REWRITE_CHARS) {
    const systemPrompt = withChineseVariant(
      body.rewriteMode === 'rewrite' ? REWRITE_SYSTEM_PROMPT : CLEAN_SYSTEM_PROMPT,
      body.chineseVariant,
    );
    const userMessage = buildRewriteUserMessage(rawText, body.keywords, body.projectContext);

    const primaryRewrite = (async () => {
      const primaryStarted = Date.now();
      if (tier === 'quality') {
        const region = resolveQwenRewriteRegion(env, continent, body.regionPreference);
        if (region.apiKey) {
          try {
            finalText = await qwenRewrite(region, systemPrompt, userMessage);
            rewriteEngine = 'qwen-plus';
            primaryMs = Date.now() - primaryStarted;
            return;
          } catch (err) {
            fallback.rewrite = toReasonCode(err, 'qwen_rewrite');
          }
        }
        if (env.ANTHROPIC_API_KEY) {
          try {
            finalText = await haikuRewrite(env, systemPrompt, userMessage);
            rewriteEngine = HAIKU_MODEL;
            primaryMs = Date.now() - primaryStarted;
            return;
          } catch (err) {
            fallback.rewrite = fallback.rewrite ?? toReasonCode(err, 'anthropic');
          }
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
      primaryMs = Date.now() - primaryStarted;
    })();

    const shadowAltRewrite =
      tier === 'quality' && body.compareRewrite && env.ANTHROPIC_API_KEY
        ? (async () => {
            const altStarted = Date.now();
            try {
              const text = await haikuRewrite(env, systemPrompt, userMessage);
              rewriteComparison = { altEngine: HAIKU_MODEL, altText: text, altMs: Date.now() - altStarted };
            } catch (err) {
              rewriteComparison = { altEngine: HAIKU_MODEL, altError: toReasonCode(err, 'anthropic'), altMs: Date.now() - altStarted };
            }
          })()
        : Promise.resolve();

    await Promise.all([primaryRewrite, shadowAltRewrite]);
  }
  const rewriteMs = primaryMs;
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
