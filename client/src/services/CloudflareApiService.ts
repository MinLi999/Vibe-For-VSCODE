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
        const prefix = 'VibeFox, TypeScript, VS Code. 好的，我开始写代码。涉及的代码词汇和变量名有：';
        const suffix = '。另外，在语气停顿处请加上标点符号（如逗号、句号、问号）。';
        const maxBytes = 800;
        let promptVal = prefix;
        const encoder = new TextEncoder();
        for (let i = 0; i < keywords.length; i++) {
          const part = (i === 0 ? '' : ', ') + keywords[i];
          const candidate = promptVal + part + suffix;
          if (encoder.encode(candidate).length > maxBytes) {
            break;
          }
          promptVal += part;
        }
        promptVal += suffix;
        formData.append('prompt', promptVal);
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

  async transcribeAliyun(endpoint: string, apiKey: string, audioBase64: string, language: string, keywords: string[]): Promise<string> {
    const baseUrl = endpoint.trim().length > 0
      ? endpoint.replace(/\/+$/, '')
      : 'https://dashscope.aliyuncs.com';

    // Normalize base domain by stripping trailing API path suffixes
    let baseDomain = baseUrl;
    if (baseDomain.includes('/compatible-mode/v1')) {
      baseDomain = baseDomain.replace('/compatible-mode/v1', '');
    }
    if (baseDomain.endsWith('/api/v1')) {
      baseDomain = baseDomain.substring(0, baseDomain.length - 7);
    }

    const submitUrl = `${baseDomain}/api/v1/services/audio/asr/transcription`;

    // 1. Submit asynchronous transcription task
    const submitController = new AbortController();
    const submitTimeout = setTimeout(() => submitController.abort(), 12000); // 12s timeout for cross-border upload
    let submitResponse: Response;

    try {
      submitResponse = await fetch(submitUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'X-DashScope-Async': 'enable',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'paraformer-v2',
          input: {
            file_urls: [`data:audio/mp3;base64,${audioBase64}`],
          },
          parameters: {
            language_hints: [language || 'zh'],
          },
        }),
        signal: submitController.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ApiError('timeout', '提交转写任务网络超时(12s)，请检查到阿里云的网络连接');
      }
      throw new ApiError('network', `提交转写任务连接失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(submitTimeout);
    }

    if (!submitResponse.ok) {
      let errDetail = `HTTP ${submitResponse.status}`;
      try {
        const errBody = (await submitResponse.json()) as { error?: { message?: string }; message?: string };
        if (errBody?.message) {
          errDetail = errBody.message;
        } else if (errBody?.error?.message) {
          errDetail = errBody.error.message;
        }
      } catch {}
      throw new ApiError('server', `提交转写任务失败: ${errDetail}`, submitResponse.status);
    }

    const submitBody = (await submitResponse.json()) as { output?: { task_id?: string } };
    const taskId = submitBody?.output?.task_id;
    if (!taskId) {
      throw new ApiError('server', '未获取到转写任务 ID');
    }

    // 2. Poll task status until finished (SUCCEEDED or FAILED)
    const taskUrl = `${baseDomain}/api/v1/tasks/${taskId}`;
    let status = 'PENDING';
    let results: { transcription_url?: string }[] = [];
    const maxPollAttempts = 40; // 40 attempts * 200ms = 8 seconds max
    
    for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 200));

      const pollController = new AbortController();
      const pollTimeout = setTimeout(() => pollController.abort(), 6000); // 6s timeout per poll
      let pollResponse: Response;

      try {
        pollResponse = await fetch(taskUrl, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
          signal: pollController.signal,
        });
      } catch (err) {
        // Log poll connection issues and try again on next attempt
        console.warn(`[Vibe Poll Warning] Attempt ${attempt} failed:`, err);
        continue;
      } finally {
        clearTimeout(pollTimeout);
      }

      if (!pollResponse.ok) {
        throw new ApiError('server', `轮询任务状态失败: HTTP ${pollResponse.status}`, pollResponse.status);
      }

      const pollBody = (await pollResponse.json()) as {
        output?: { task_status?: string; results?: { transcription_url?: string }[]; message?: string };
      };
      
      status = pollBody?.output?.task_status || 'PENDING';
      if (status === 'SUCCEEDED') {
        results = pollBody?.output?.results || [];
        break;
      } else if (status === 'FAILED') {
        throw new ApiError('server', `转写任务失败: ${pollBody?.output?.message || '未知错误'}`);
      }
    }

    if (status !== 'SUCCEEDED') {
      throw new ApiError('timeout', '转写任务处理超时，请重试');
    }

    const transcriptionUrl = results?.[0]?.transcription_url;
    if (!transcriptionUrl) {
      throw new ApiError('server', '未获取到转写结果 URL');
    }

    // 3. Fetch transcription JSON from transcription_url
    const resultController = new AbortController();
    const resultTimeout = setTimeout(() => resultController.abort(), 8000); // 8s timeout to download result
    let resultResponse: Response;

    try {
      resultResponse = await fetch(transcriptionUrl, {
        signal: resultController.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ApiError('timeout', '下载转写结果超时(8s)，请重试');
      }
      throw new ApiError('network', `下载转写结果失败: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(resultTimeout);
    }

    if (!resultResponse.ok) {
      throw new ApiError('server', `获取转写文件失败: HTTP ${resultResponse.status}`);
    }

    const resultBody = (await resultResponse.json()) as {
      transcripts?: {
        sentences?: { text?: string }[];
      }[];
    };

    const transcripts = resultBody?.transcripts || [];
    const text = transcripts
      .flatMap((t) => t.sentences || [])
      .map((s) => s.text || '')
      .filter((t) => t.length > 0)
      .join(' ');

    return text.trim();
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
