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
export function buildInitialPrompt(keywords: string[], previousTranscript?: string): string | undefined {
  const cleaned = keywords
    .filter((k): k is string => typeof k === 'string')
    .map((k) => k.trim())
    .filter((k) => k.length > 0 && k.length <= MAX_KEYWORD_LENGTH)
    .slice(0, MAX_KEYWORDS);

  let promptVal = '';
  if (previousTranscript && previousTranscript.trim().length > 0) {
    promptVal += previousTranscript.trim().slice(-300) + '。';
  }

  if (cleaned.length > 0) {
    const prefix = '好的，我现在打开了项目。刚才看了一下代码，里面用到了 ';
    const suffix = ' 这些。现在我要开始说一下修改思路。';
    const maxBytes = 800;
    const encoder = new TextEncoder();
    let keywordsPart = '';
    for (let i = 0; i < cleaned.length; i++) {
      const sep = i === 0 ? '' : '、';
      const part = sep + cleaned[i];
      if (encoder.encode(promptVal + prefix + keywordsPart + part + suffix).length > maxBytes) {
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

/** Validates and normalizes the request body; throws HttpError directly if invalid. */
export function parseRequestBody(raw: unknown): Required<Pick<TranscribeRequestBody, 'audio' | 'language'>> & {
  keywords: string[];
  previousTranscript?: string;
  llmCorrect?: boolean;
  llmPrompt?: string;
  llmModel?: string;
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

  const previousTranscript = typeof body['previousTranscript'] === 'string' ? body['previousTranscript'] : undefined;
  const llmCorrect = typeof body['llmCorrect'] === 'boolean' ? body['llmCorrect'] : undefined;
  const llmPrompt = typeof body['llmPrompt'] === 'string' ? body['llmPrompt'] : undefined;
  const llmModel = typeof body['llmModel'] === 'string' ? body['llmModel'] : undefined;

  return { audio, language, keywords, previousTranscript, llmCorrect, llmPrompt, llmModel };
}

/** Core handler: validate → build prompt → call Whisper → build response. */
export async function handleTranscribe(request: Request, env: Env): Promise<TranscribeResponseBody> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }

  const { audio, language, keywords, previousTranscript, llmCorrect, llmPrompt, llmModel } = parseRequestBody(raw);
  const initialPrompt = buildInitialPrompt(keywords, previousTranscript);

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

  let text = typeof result?.text === 'string' ? result.text.trim() : '';
  if (text.length === 0) {
    throw new HttpError(502, 'Transcription produced no text (silent audio or model failure)');
  }

  // Handle LLM post-processing correction on Cloudflare side
  if (llmCorrect) {
    const prompt = llmPrompt || '你是一个编程语音转文字后处理器。请修正转写文本中的错误标点，修复代码标识符拼写，去除填充词，不要改变原意。直接输出修改后的文本，不要带有任何解释或包裹符号。';
    const model = llmModel || '@cf/meta/llama-3.1-8b-instruct';
    try {
      const llmResult = await env.AI.run(model as any, {
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: `参考代码词表：${keywords.join(', ')}\n\n待转写文本：${text}` }
        ]
      });
      const responseText = (llmResult as any).response || (llmResult as any).text;
      if (typeof responseText === 'string' && responseText.trim().length > 0) {
        text = responseText.trim();
      }
    } catch (err) {
      console.error('[Cloudflare Workers AI LLM Correction Error]', err);
      // Fail gracefully: return the raw transcribed text on error instead of failing the request
    }
  }

  return { text, duration_ms: Date.now() - started };
}
