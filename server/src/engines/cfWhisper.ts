import { EngineError } from '../errors';
import type { Env, WhisperTurboInput, WhisperTurboOutput } from '../types';

const MODEL_ID = '@cf/openai/whisper-large-v3-turbo';
const WHISPER_TIMEOUT_MS = 20_000;

/**
 * `AI.run` accepts no AbortSignal; the race only stops us from waiting (the inference may
 * finish in the background), which is fine — the client has long since fallen back.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, code: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new EngineError('asr', code)), ms)),
  ]);
}

/** Cloudflare-edge Whisper transcription (free tier + fallback for the quality tier). */
export async function whisperTranscribe(
  env: Env,
  audioBase64: string,
  language: string,
  initialPrompt: string | undefined,
): Promise<string> {
  const input: WhisperTurboInput = {
    audio: audioBase64,
    task: 'transcribe',
    // Explicit language lock (defaults to zh) bypasses the extra latency and misdetection
    // that Whisper's automatic language detection introduces.
    language,
    vad_filter: true,
    // Deterministic decoding: kills sampling randomness between identical utterances.
    temperature: 0,
    ...(initialPrompt !== undefined ? { initial_prompt: initialPrompt } : {}),
  };

  // Workers AI's model-id → input/output mapping is determined at runtime; this calls the
  // whisper-large-v3-turbo JSON shape (audio=base64) per the 2026 docs and declares the
  // fields this service consumes locally.
  const result = (await withTimeout(
    env.AI.run(MODEL_ID as Parameters<Ai['run']>[0], input as unknown as Parameters<Ai['run']>[1]),
    WHISPER_TIMEOUT_MS,
    'cf_whisper_timeout',
  )) as WhisperTurboOutput;

  return typeof result?.text === 'string' ? result.text.trim() : '';
}
