/**
 * Service layer: Cloudflare Worker HTTPS communication.
 * Contract fields stay in sync with server/src/types.ts; errors are mapped to typed Errors for the Controller.
 */

export interface TranscribeRequest {
  /** Base64 MP3. */
  audio: string;
  language: string;
  keywords: string[];
}

export interface TranscribeResponse {
  text: string;
  duration_ms: number;
}

export type ApiErrorKind =
  | 'unauthorized' // 401/403 — license key missing/invalid, prompt to reset
  | 'payload-too-large' // 413 — recording too long
  | 'server' // 5xx / other status codes
  | 'network' // connection failure / DNS
  | 'timeout'; // AbortController timeout

export class ApiError extends Error {
  constructor(
    public readonly kind: ApiErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

const REQUEST_TIMEOUT_MS = 60_000;

export class CloudflareApiService {
  /**
   * POST {endpoint}/api/transcribe, Bearer-authenticated, 60s timeout.
   * @param endpoint Worker base URL (no trailing slash; the Controller has already checked it's non-empty)
   */
  async transcribe(endpoint: string, licenseKey: string, request: TranscribeRequest): Promise<TranscribeResponse> {
    const url = `${endpoint.replace(/\/+$/, '')}/api/transcribe`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${licenseKey}`,
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ApiError('timeout', `转写请求超时(${REQUEST_TIMEOUT_MS / 1000}s)`);
      }
      throw new ApiError('network', `无法连接转写服务:${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const detail = await CloudflareApiService.errorDetail(response);
      if (response.status === 401 || response.status === 403) {
        throw new ApiError('unauthorized', detail, response.status);
      }
      if (response.status === 413) {
        throw new ApiError('payload-too-large', detail, response.status);
      }
      throw new ApiError('server', detail, response.status);
    }

    const body = (await response.json()) as Partial<TranscribeResponse>;
    if (typeof body.text !== 'string') {
      throw new ApiError('server', '转写服务返回了非预期的响应形态', response.status);
    }
    return { text: body.text, duration_ms: body.duration_ms ?? 0 };
  }

  private static async errorDetail(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as { error?: string };
      if (typeof body.error === 'string') {
        return body.error;
      }
    } catch {
      /* Not a JSON error body. */
    }
    return `HTTP ${response.status}`;
  }
}
