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

  async transcribeGroq(apiKey: string, audioBase64: string, language: string, keywords: string[]): Promise<string> {
    return this.transcribeOpenAICompatible(
      'https://api.groq.com/openai/v1/audio/transcriptions',
      apiKey,
      'whisper-large-v3',
      audioBase64,
      language,
      keywords
    );
  }

  async transcribeOpenAI(apiKey: string, audioBase64: string, language: string, keywords: string[]): Promise<string> {
    return this.transcribeOpenAICompatible(
      'https://api.openai.com/v1/audio/transcriptions',
      apiKey,
      'whisper-1',
      audioBase64,
      language,
      keywords
    );
  }

  private async transcribeOpenAICompatible(
    url: string,
    apiKey: string,
    model: string,
    audioBase64: string,
    language: string,
    keywords: string[]
  ): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const buffer = Buffer.from(audioBase64, 'base64');
      const blob = new Blob([buffer], { type: 'audio/mp3' });
      const formData = new FormData();
      formData.append('file', blob, 'audio.mp3');
      formData.append('model', model);
      formData.append('language', language);
      if (keywords.length > 0) {
        formData.append('prompt', `涉及的英文专业词汇如下：${keywords.join(', ')}。`);
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        let errDetail = `HTTP ${response.status}`;
        try {
          const errBody = (await response.json()) as { error?: { message?: string } };
          if (errBody?.error?.message) {
            errDetail = errBody.error.message;
          }
        } catch {}
        throw new ApiError('server', errDetail, response.status);
      }

      const body = (await response.json()) as { text?: string };
      if (typeof body.text !== 'string') {
        throw new ApiError('server', '转写响应中没有包含 text 字段', response.status);
      }
      return body.text;
    } catch (err) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ApiError('timeout', `转写请求超时(${REQUEST_TIMEOUT_MS / 1000}s)`);
      }
      throw new ApiError('network', `请求失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  async transcribeCustom(endpoint: string, audioBase64: string, language: string, keywords: string[]): Promise<string> {
    const url = endpoint.replace(/\/+$/, '');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          audio: audioBase64,
          language,
          keywords,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new ApiError('server', `HTTP ${response.status}`, response.status);
      }

      const body = (await response.json()) as { text?: string };
      if (typeof body.text !== 'string') {
        throw new ApiError('server', '自定义服务返回中缺少 text 字段', response.status);
      }
      return body.text;
    } catch (err) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ApiError('timeout', `转写请求超时(${REQUEST_TIMEOUT_MS / 1000}s)`);
      }
      throw new ApiError('network', `无法连接自定义服务: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timeout);
    }
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
