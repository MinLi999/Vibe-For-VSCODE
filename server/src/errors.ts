/** HTTP error thrown by request handling; mapped to a JSON error response by index.ts. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Engine-stage failure (ASR or rewrite). Carries a short reason code that is surfaced to the
 * client in the response's `fallback` field and to logs — never the provider's raw error body.
 */
export class EngineError extends Error {
  constructor(
    public readonly stage: 'asr' | 'rewrite',
    public readonly code: string,
  ) {
    super(`${stage} engine failed: ${code}`);
  }
}

/** Normalizes an unknown thrown value into a short fallback reason code. */
export function toReasonCode(err: unknown, prefix: string): string {
  if (err instanceof EngineError) {
    return err.code;
  }
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return `${prefix}_timeout`;
  }
  return `${prefix}_error`;
}
