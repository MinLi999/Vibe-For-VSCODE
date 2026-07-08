import type {
  Env,
  TranscribeRequestBody,
  TranscribeResponseBody,
  WhisperTurboInput,
  WhisperTurboOutput,
} from './types';

const MODEL_ID = '@cf/openai/whisper-large-v3-turbo';

/** MAX_AUDIO_BASE64: 8MB base64 (≈6MB audio). A 25s 32kbps MP3 is only ~100KB; this is a hard ceiling, not the norm. */
const MAX_AUDIO_BASE64 = 8 * 1024 * 1024;

/** Safe truncation length for Whisper's initial_prompt (leaves headroom for prompt tokens). */
const MAX_INITIAL_PROMPT_CHARS = 896;

const MAX_KEYWORDS = 40;
const MAX_KEYWORD_LENGTH = 64;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const LANGUAGE_PATTERN = /^[a-z]{2}$/;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Assembles the client's keyword list into Whisper's initial_prompt:
 * a Chinese scene-setting sentence + comma-separated vocabulary. Whisper treats this as
 * preceding context, biasing similar-sounding speech toward these code identifiers
 * (preventing variable names from being transcribed as phonetically-similar Chinese characters).
 */
export function buildInitialPrompt(keywords: string[]): string | undefined {
  const cleaned = keywords
    .filter((k): k is string => typeof k === 'string')
    .map((k) => k.trim())
    .filter((k) => k.length > 0 && k.length <= MAX_KEYWORD_LENGTH)
    .slice(0, MAX_KEYWORDS);

  if (cleaned.length === 0) {
    return undefined;
  }

  const prompt = `以下是一段关于编程的中文口述,可能提及这些标识符:${cleaned.join(', ')}。`;
  return prompt.length > MAX_INITIAL_PROMPT_CHARS ? prompt.slice(0, MAX_INITIAL_PROMPT_CHARS) : prompt;
}

/** Validates and normalizes the request body; throws HttpError directly if invalid. */
export function parseRequestBody(raw: unknown): Required<Pick<TranscribeRequestBody, 'audio' | 'language'>> & {
  keywords: string[];
} {
  if (typeof raw !== 'object' || raw === null) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  const body = raw as Record<string, unknown>;

  const audio = body['audio'];
  if (typeof audio !== 'string' || audio.length === 0) {
    throw new HttpError(400, 'Field "audio" (base64 string) is required');
  }
  if (audio.length > MAX_AUDIO_BASE64) {
    throw new HttpError(413, `Audio payload too large (>${MAX_AUDIO_BASE64} base64 chars); keep recordings under the client limit`);
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
    keywords = body['keywords'].filter((k): k is string => typeof k === 'string');
  }

  return { audio, language, keywords };
}

/** Core handler: validate → build prompt → call Whisper → build response. */
export async function handleTranscribe(request: Request, env: Env): Promise<TranscribeResponseBody> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }

  const { audio, language, keywords } = parseRequestBody(raw);
  const initialPrompt = buildInitialPrompt(keywords);

  const input: WhisperTurboInput = {
    audio,
    task: 'transcribe',
    // Explicit language lock (defaults to zh) bypasses the extra latency and misdetection
    // that Whisper's automatic language detection introduces.
    language,
    vad_filter: true,
    ...(initialPrompt !== undefined ? { initial_prompt: initialPrompt } : {}),
  };

  const started = Date.now();
  // Workers AI's model-id → input/output mapping is determined at runtime; this calls the
  // whisper-large-v3-turbo JSON shape (audio=base64) per the 2026 docs and declares the
  // fields this service consumes locally.
  const result = (await env.AI.run(
    MODEL_ID as Parameters<Ai['run']>[0],
    input as unknown as Parameters<Ai['run']>[1],
  )) as WhisperTurboOutput;

  const text = typeof result?.text === 'string' ? result.text.trim() : '';
  if (text.length === 0) {
    throw new HttpError(502, 'Transcription produced no text (silent audio or model failure)');
  }

  return { text, duration_ms: Date.now() - started };
}
