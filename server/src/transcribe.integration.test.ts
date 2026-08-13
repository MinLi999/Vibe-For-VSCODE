import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthResult } from './auth';
import { HttpError } from './errors';
import { handleTranscribe } from './transcribe';
import type { Env } from './types';

/**
 * Orchestration-level integration tests: the full ASR chain (Qwen → degenerate-result guard →
 * Whisper fallback → 502) and rewrite chain (qwen-plus → llama → raw text) with both engines
 * mocked at their I/O boundaries (global fetch for DashScope, env.AI.run for Workers AI).
 * Until now only parseRequestBody had coverage — every fallback path in handleTranscribe
 * itself was exercised in production only.
 */

const AUDIO = 'QUJD';

function proAuth(): AuthResult & { ok: true } {
  return { ok: true, key: 'vf-pro', metadata: { owner: 'test', plan: 'pro' } };
}

function freeAuth(): AuthResult & { ok: true } {
  return { ok: true, key: 'vf-free', metadata: { owner: 'test' } };
}

interface MockBehavior {
  /** Response text for the Qwen ASR fetch; a function may throw to simulate network failure. */
  qwenAsr?: () => string;
  /** Response text for the qwen-plus rewrite fetch. */
  qwenRewrite?: () => string;
  whisper?: () => string;
  llama?: () => string;
}

function makeEnv(behavior: MockBehavior, withDashscopeKeys: boolean): Env {
  return {
    DASHSCOPE_BASE_URL_APAC: 'https://apac.mock',
    DASHSCOPE_BASE_URL_US: 'https://us.mock',
    QWEN_MODEL_APAC: 'qwen3-asr-flash',
    QWEN_MODEL_US: 'qwen3-asr-flash-us',
    QWEN_REWRITE_MODEL: 'qwen-plus',
    ...(withDashscopeKeys ? { DASHSCOPE_API_KEY_APAC: 'k-apac', DASHSCOPE_API_KEY_US: 'k-us' } : {}),
    AI: {
      run: async (model: string) => {
        if (String(model).includes('whisper')) {
          if (!behavior.whisper) throw new Error('unexpected whisper call');
          return { text: behavior.whisper() };
        }
        if (!behavior.llama) throw new Error('unexpected llama call');
        return { response: behavior.llama() };
      },
    },
  } as unknown as Env;
}

function stubFetch(behavior: MockBehavior): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('multimodal-generation')) {
      if (!behavior.qwenAsr) throw new Error('unexpected qwen asr call');
      const text = behavior.qwenAsr();
      return new Response(
        JSON.stringify({ output: { choices: [{ message: { content: [{ text }] } }] } }),
        { status: 200 },
      );
    }
    if (url.includes('text-generation')) {
      if (!behavior.qwenRewrite) throw new Error('unexpected qwen rewrite call');
      const text = behavior.qwenRewrite();
      return new Response(
        JSON.stringify({ output: { choices: [{ message: { content: text } }] } }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function transcribeRequest(overrides: Record<string, unknown> = {}): Request {
  return new Request('https://worker.test/api/transcribe', {
    method: 'POST',
    body: JSON.stringify({ audio: AUDIO, language: 'auto', rewriteMode: 'clean', ...overrides }),
  });
}

type WorkerRequest = Parameters<typeof handleTranscribe>[0];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('handleTranscribe orchestration', () => {
  it('quality tier happy path: Qwen ASR + qwen-plus rewrite, no fallback codes', async () => {
    const behavior: MockBehavior = {
      qwenAsr: () => '帮我把这个函数重构一下,把重复的逻辑抽出来',
      qwenRewrite: () => '帮我重构这个函数,抽出重复逻辑',
    };
    stubFetch(behavior);
    const result = await handleTranscribe(transcribeRequest() as WorkerRequest, makeEnv(behavior, true), proAuth());
    expect(result.engines.asr).toBe('qwen3-asr-flash');
    expect(result.engines.rewrite).toBe('qwen-plus');
    expect(result.finalText).toBe('帮我重构这个函数,抽出重复逻辑');
    expect(result.rawText).toBe('帮我把这个函数重构一下,把重复的逻辑抽出来');
    expect(result.fallback).toBeUndefined();
    expect(result.tier).toBe('quality');
  });

  it('free tier never touches DashScope: Whisper + llama only', async () => {
    const behavior: MockBehavior = {
      whisper: () => '把这一段代码里的等号检查一下',
      llama: () => '检查这段代码里的等号',
    };
    stubFetch({}); // Any DashScope fetch would throw "unexpected".
    const result = await handleTranscribe(transcribeRequest() as WorkerRequest, makeEnv(behavior, true), freeAuth());
    expect(result.engines.asr).toBe('cf-whisper-large-v3-turbo');
    expect(result.engines.rewrite).toBe('cf-llama-3.1-8b-instruct');
    expect(result.tier).toBe('free');
  });

  it('degenerate Qwen result (empty) falls back to Whisper with a reason code', async () => {
    const behavior: MockBehavior = {
      qwenAsr: () => '',
      whisper: () => '这句话其实是有内容的,只是 Qwen 抽风了',
      llama: () => '这句话有内容,只是 Qwen 抽风了',
    };
    stubFetch(behavior);
    const result = await handleTranscribe(transcribeRequest() as WorkerRequest, makeEnv(behavior, true), proAuth());
    expect(result.engines.asr).toBe('cf-whisper-large-v3-turbo');
    expect(result.fallback?.asr).toBe('dashscope_empty_result');
  });

  it('Qwen reciting the injected vocabulary is treated as degenerate (context echo)', async () => {
    const keywords = ['Cloudflare Workers', 'Claude Code', 'DashScope', 'Anthropic'];
    const behavior: MockBehavior = {
      qwenAsr: () => 'Cloudflare Workers, Claude Code, DashScope, Anthropic',
      whisper: () => '部署到 Cloudflare 的流程帮我理一下,从构建到发布每一步都列出来',
      llama: () => '帮我梳理部署到 Cloudflare 的流程,从构建到发布逐步列出',
    };
    stubFetch(behavior);
    const result = await handleTranscribe(
      transcribeRequest({ keywords }) as WorkerRequest,
      makeEnv(behavior, true),
      proAuth(),
    );
    expect(result.engines.asr).toBe('cf-whisper-large-v3-turbo');
    expect(result.fallback?.asr).toBe('dashscope_context_echo');
  });

  it('Qwen network failure falls back to Whisper instead of failing the request', async () => {
    const behavior: MockBehavior = {
      qwenAsr: () => {
        throw new Error('boom');
      },
      whisper: () => '网络断了也不能丢用户这句话',
      llama: () => '网络断了也不能丢这句话',
    };
    stubFetch(behavior);
    const result = await handleTranscribe(transcribeRequest() as WorkerRequest, makeEnv(behavior, true), proAuth());
    expect(result.engines.asr).toBe('cf-whisper-large-v3-turbo');
    expect(result.fallback?.asr).toBeTruthy();
  });

  it('both engines empty -> 502 (the silent-loss path the client must handle)', async () => {
    const behavior: MockBehavior = {
      qwenAsr: () => '',
      whisper: () => '',
    };
    stubFetch(behavior);
    await expect(
      handleTranscribe(transcribeRequest() as WorkerRequest, makeEnv(behavior, true), proAuth()),
    ).rejects.toSatisfy((e: unknown) => e instanceof HttpError && e.status === 502);
  });

  it('filler-only ASR output ("嗯。") is filtered to a 502, never delivered', async () => {
    const behavior: MockBehavior = {
      qwenAsr: () => '嗯。',
      whisper: () => '嗯。',
    };
    stubFetch(behavior);
    await expect(
      handleTranscribe(transcribeRequest() as WorkerRequest, makeEnv(behavior, true), proAuth()),
    ).rejects.toSatisfy((e: unknown) => e instanceof HttpError && e.status === 502);
  });

  it('qwen-plus rewrite failure falls back to llama with a reason code', async () => {
    const behavior: MockBehavior = {
      qwenAsr: () => '这句要走改写但 qwen-plus 会挂掉的长句子',
      qwenRewrite: () => {
        throw new Error('rewrite down');
      },
      llama: () => '这句改写由 llama 兜底完成',
    };
    stubFetch(behavior);
    const result = await handleTranscribe(transcribeRequest() as WorkerRequest, makeEnv(behavior, true), proAuth());
    expect(result.engines.rewrite).toBe('cf-llama-3.1-8b-instruct');
    expect(result.fallback?.rewrite).toBeTruthy();
    expect(result.finalText).toBe('这句改写由 llama 兜底完成');
  });

  it('every rewrite engine down -> raw text is still delivered (graceful degradation)', async () => {
    const behavior: MockBehavior = {
      qwenAsr: () => '两个改写引擎都挂了也要把原文给用户',
      qwenRewrite: () => {
        throw new Error('down');
      },
      llama: () => {
        throw new Error('down too');
      },
    };
    stubFetch(behavior);
    const result = await handleTranscribe(transcribeRequest() as WorkerRequest, makeEnv(behavior, true), proAuth());
    expect(result.engines.rewrite).toBe('none');
    expect(result.finalText).toBe(result.rawText);
  });

  it('rewriteMode off skips the rewrite stage entirely', async () => {
    const behavior: MockBehavior = {
      qwenAsr: () => '原样转写模式下这句一个字都不能动',
    };
    stubFetch(behavior);
    const result = await handleTranscribe(
      transcribeRequest({ rewriteMode: 'off' }) as WorkerRequest,
      makeEnv(behavior, true),
      proAuth(),
    );
    expect(result.engines.rewrite).toBe('none');
    expect(result.finalText).toBe(result.rawText);
  });

  it('short utterances (<10 chars) skip the rewrite stage (cost guard)', async () => {
    const behavior: MockBehavior = {
      qwenAsr: () => '继续',
    };
    stubFetch(behavior);
    const result = await handleTranscribe(transcribeRequest() as WorkerRequest, makeEnv(behavior, true), proAuth());
    expect(result.engines.rewrite).toBe('none');
    expect(result.finalText).toBe('继续');
  });

  it('v1 compatibility: llmCorrect:true maps to clean mode', async () => {
    const behavior: MockBehavior = {
      whisper: () => '老客户端发的 v1 请求也要走清理',
      llama: () => 'v1 请求清理完成',
    };
    stubFetch({});
    const result = await handleTranscribe(
      new Request('https://worker.test/api/transcribe', {
        method: 'POST',
        body: JSON.stringify({ audio: AUDIO, llmCorrect: true }),
      }) as WorkerRequest,
      makeEnv(behavior, true),
      freeAuth(),
    );
    expect(result.engines.rewrite).toBe('cf-llama-3.1-8b-instruct');
    expect(result.text).toBe(result.finalText); // v1 alias field intact.
  });
});
