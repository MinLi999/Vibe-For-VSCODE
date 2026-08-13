import { EngineError } from '../errors';
import type { Env, WhisperTurboInput, WhisperTurboOutput } from '../types';

const MODEL_ID = '@cf/openai/whisper-large-v3-turbo';
/**
 * Same scaling rationale as qwenAsr.ts asrTimeoutMs: Whisper is the LAST line of defense, so
 * a flat deadline that a long take can't meet turns into a silent 502. Floor stays at the
 * historical 20s; long audio gets more room, capped so the client's 60s ceiling still holds.
 */
const WHISPER_TIMEOUT_FLOOR_MS = 20_000;
const WHISPER_TIMEOUT_CEILING_MS = 45_000;
const WHISPER_TIMEOUT_PER_SECOND_MS = 300;
const APPROX_BYTES_PER_AUDIO_SECOND = 4_000;

function whisperTimeoutMs(audioBase64Length: number): number {
  const seconds = (audioBase64Length * 0.75) / APPROX_BYTES_PER_AUDIO_SECOND;
  return Math.min(WHISPER_TIMEOUT_CEILING_MS, WHISPER_TIMEOUT_FLOOR_MS + seconds * WHISPER_TIMEOUT_PER_SECOND_MS);
}

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
    whisperTimeoutMs(audioBase64.length),
    'cf_whisper_timeout',
  )) as WhisperTurboOutput;

  return typeof result?.text === 'string' ? result.text.trim() : '';
}
