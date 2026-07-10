/**
 * Cross-service contract: fields must stay in sync with client/src/services/CloudflareApiService.ts.
 */

export interface Env {
  /** Workers AI binding (wrangler.jsonc → "ai".binding). */
  AI: Ai;
  /** KV for license key existence checks (key = license key, value = metadata JSON). */
  AUTH_KEYS: KVNamespace;
}

/** POST /api/transcribe request body. */
export interface TranscribeRequestBody {
  /** Base64-encoded MP3 (16kHz mono ~32kbps, compressed client-side). */
  audio: string;
  /** ISO-639-1; defaults to "zh", passed explicitly to Whisper to bypass auto-detection latency. */
  language?: string;
  /** Context vocabulary extracted by the client (variable names / filenames), injected into initial_prompt. */
  keywords?: string[];
  previousTranscript?: string;
  llmCorrect?: boolean;
  llmPrompt?: string;
  llmModel?: string;
}

/** Success response. */
export interface TranscribeResponseBody {
  text: string;
  /** Worker-side processing time (including AI inference), milliseconds. */
  duration_ms: number;
}

/** Error response (unified shape for all non-2xx). */
export interface ErrorResponseBody {
  error: string;
}

/** Shape of the KV value's metadata (logging only, not used in auth decisions). */
export interface LicenseMetadata {
  owner?: string;
  plan?: string;
}

/** whisper-large-v3-turbo input (JSON shape). */
export interface WhisperTurboInput {
  audio: string;
  task?: 'transcribe' | 'translate';
  language?: string;
  vad_filter?: boolean;
  initial_prompt?: string;
  prefix?: string;
}

/** whisper-large-v3-turbo output (only the fields this service consumes). */
export interface WhisperTurboOutput {
  text?: string;
  transcription_info?: {
    language?: string;
    duration?: number;
  };
}
