import type { AuthResult } from './auth';
import { llamaRewrite } from './engines/cfLlama';
import { whisperTranscribe } from './engines/cfWhisper';
import { qwenTranscribe, resolveQwenRegion } from './engines/qwenAsr';
import { qwenRewrite, resolveQwenRewriteRegion } from './engines/qwenRewrite';
import { HttpError, toReasonCode } from './errors';
import { isContextEcho, isNonSpeechTranscript } from './nonspeech';
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
/**
 * 'auto' (the v2 client default) means: let Qwen3-ASR auto-detect — the official docs say NOT
 * to pin a language on mixed-language audio (our zh/en code-switching core case; pinning 'zh'
 * was dragging English words toward Chinese phonetics). The Whisper fallback still gets an
 * explicit 'zh' (its auto-detection latency/misdetection rationale is unchanged).
 */
const LANGUAGE_PATTERN = /^(auto|[a-z]{2})$/;
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
  capturePeak?: number;
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

  // Absent field keeps the historical v1 default ('zh'); v2 clients send 'auto' explicitly.
  let language = 'zh';
  if (body['language'] !== undefined) {
    if (typeof body['language'] !== 'string' || !LANGUAGE_PATTERN.test(body['language'])) {
      throw new HttpError(400, 'Field "language" must be "auto" or a two-letter ISO-639-1 code');
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
  // Unknown values silently fall back to the defaults (forward compat with newer clients).
  const chineseVariant = CHINESE_VARIANTS.includes(body['chineseVariant'] as ChineseVariant)
    ? (body['chineseVariant'] as ChineseVariant)
    : 'simplified-cn';
  const regionPreference = REGION_PREFERENCES.includes(body['regionPreference'] as RegionPreference)
    ? (body['regionPreference'] as RegionPreference)
    : 'auto';

  const capturePeak = typeof body['capturePeak'] === 'number' ? body['capturePeak'] : undefined;

  return {
    audio,
    language,
    keywords,
    projectContext,
    previousTranscript,
    rewriteMode,
    enginePreference,
    capturePeak,
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
        const qwenText = await qwenTranscribe(
          region,
          body.audio,
          body.language === 'auto' ? undefined : body.language,
          body.keywords,
        );
        // Qwen intermittently returns a DEGENERATE result (empty / single char / hallucinated
        // noise-description) on audio that clearly HAD speech — reported in the field with the
        // live level meter visibly reacting. Qwen doesn't throw in that case, so before this
        // guard we accepted the garbage and 502'd without ever trying Whisper. Treat a
        // degenerate Qwen result as a soft failure and let the Cloudflare-edge Whisper fallback
        // take a second shot; only if BOTH come back empty is it genuinely no-speech.
        // isContextEcho: the model reciting the injected vocabulary instead of transcribing
        // (near-silent audio failure mode of the context-biasing channel) is equally degenerate.
        if (qwenText.length > 0 && !isNonSpeechTranscript(qwenText) && !isContextEcho(qwenText, body.keywords)) {
          rawText = qwenText;
          asrEngine = 'qwen3-asr-flash';
        } else if (isContextEcho(qwenText, body.keywords)) {
          fallback.asr = 'dashscope_context_echo';
        } else {
          fallback.asr = 'dashscope_empty_result';
        }
      } catch (err) {
        fallback.asr = toReasonCode(err, 'dashscope');
      }
    }
  }
  if (asrEngine !== 'qwen3-asr-flash') {
    rawText = await whisperTranscribe(
      env,
      body.audio,
      body.language === 'auto' ? 'zh' : body.language,
      buildInitialPrompt(body.keywords),
    );
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
        // Decisive split: high capture_peak + empty from BOTH engines = compression/pipeline
        // dropped the signal; low capture_peak = the mic only captured ambient noise (device/
        // routing/gain), not the user's voice, despite the level meter appearing to react.
        (body.capturePeak !== undefined ? ` capture_peak=${body.capturePeak}` : '') +
        (fallback.asr ? ` asr_fallback=${fallback.asr}` : ''),
    );
    throw new HttpError(502, 'Transcription produced no text (silent or non-speech audio)');
  }

  // --- Rewrite stage (quality tier): Qwen-Plus → Cloudflare llama → raw text ---
  // Qwen-Plus is the sole quality-tier rewrite engine (~3-4x cheaper than the LLM it replaced,
  // comparable quality on Chinese/EN-mixed dictation, and it reuses the region-locked DashScope
  // key the ASR stage already requires). cf-llama is the free-tier engine and the edge fallback.
  let finalText = rawText;
  let rewriteEngine: TranscribeResponseBody['engines']['rewrite'] = 'none';
  const rewriteStarted = Date.now();

  if (body.rewriteMode !== 'off' && rawText.trim().length >= MIN_REWRITE_CHARS) {
    const systemPrompt = withChineseVariant(
      body.rewriteMode === 'rewrite' ? REWRITE_SYSTEM_PROMPT : CLEAN_SYSTEM_PROMPT,
      body.chineseVariant,
    );
    const userMessage = buildRewriteUserMessage(rawText, body.keywords, body.projectContext);

    if (tier === 'quality') {
      const region = resolveQwenRewriteRegion(env, continent, body.regionPreference);
      if (region.apiKey) {
        try {
          finalText = await qwenRewrite(region, systemPrompt, userMessage);
          rewriteEngine = 'qwen-plus';
        } catch (err) {
          fallback.rewrite = toReasonCode(err, 'qwen_rewrite');
        }
      }
    }
    if (rewriteEngine === 'none') {
      try {
        finalText = await llamaRewrite(env, systemPrompt, userMessage);
        rewriteEngine = 'cf-llama-3.1-8b-instruct';
      } catch (err) {
        // Graceful degradation: keep the raw transcription rather than failing the request.
        fallback.rewrite = fallback.rewrite ?? toReasonCode(err, 'cf_llama');
        finalText = rawText;
      }
    }
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
  };
}

// Re-exported so index.ts keeps a single import site for handler + error type.
export { HttpError } from './errors';
