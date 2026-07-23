import { describe, expect, it } from 'vitest';
import { isContextEcho, isNonSpeechTranscript } from './nonspeech';

describe('isNonSpeechTranscript', () => {
  it('flags empty and punctuation-only output (ASR silence hallucination)', () => {
    expect(isNonSpeechTranscript('')).toBe(true);
    expect(isNonSpeechTranscript('   ')).toBe(true);
    expect(isNonSpeechTranscript('...')).toBe(true);
    expect(isNonSpeechTranscript('。。。…')).toBe(true);
    expect(isNonSpeechTranscript('- - -')).toBe(true);
  });

  it('flags bracketed scene descriptions', () => {
    expect(isNonSpeechTranscript('(音频中充斥着强烈的机械噪音)')).toBe(true);
    expect(isNonSpeechTranscript('【背景音乐】')).toBe(true);
    expect(isNonSpeechTranscript('(inaudible)')).toBe(true);
  });

  it('flags audio-narration prefixes', () => {
    expect(isNonSpeechTranscript('音频中没有清晰的人声')).toBe(true);
    expect(isNonSpeechTranscript('本段音频无法识别')).toBe(true);
  });

  it('flags short subtitle-watermark spam but not long real sentences mentioning those words', () => {
    expect(isNonSpeechTranscript('请点赞订阅')).toBe(true);
    expect(isNonSpeechTranscript('Thank you for watching')).toBe(true);
    expect(isNonSpeechTranscript('字幕由 Amara.org 社区提供')).toBe(true);
    // Over 30 chars: a real dictation that merely mentions 字幕 must survive.
    expect(isNonSpeechTranscript('我们需要给视频播放器加一个字幕解析模块,要求支持 SRT 和 ASS 两种格式的加载和渲染')).toBe(false);
  });

  it('passes real dictation through, including spoken symbol words', () => {
    expect(isNonSpeechTranscript('帮我修复这个 bug,顺便把等号那一行也检查一下')).toBe(false);
    expect(isNonSpeechTranscript('把 AudioRecorderService 的重试逻辑改成确认式启动')).toBe(false);
  });
});

describe('isContextEcho', () => {
  const keywords = ['Cloudflare Workers', 'Cloudflare', 'Claude Code', 'Anthropic', 'DashScope'];

  it('flags a transcript that is just the injected vocabulary read back out', () => {
    expect(isContextEcho('Cloudflare Workers, Claude Code, Anthropic, DashScope', keywords)).toBe(true);
    // Longest-first consumption: "Cloudflare Workers" must not leave a "Workers" stub that
    // counts as residual real speech.
    expect(isContextEcho('Cloudflare Workers Cloudflare Claude Code', keywords)).toBe(true);
  });

  it('passes real speech that happens to contain keywords', () => {
    expect(isContextEcho('帮我把 Claude Code 的配置改一下,然后部署到 Cloudflare Workers 上面去', keywords)).toBe(false);
  });

  it('exempts short utterances instead of risking false positives on a single keyword', () => {
    expect(isContextEcho('Claude Code', keywords)).toBe(false);
    expect(isContextEcho('commit', ['commit'])).toBe(false);
  });

  it('never flags when no context was injected', () => {
    expect(isContextEcho('Cloudflare Workers Claude Code Anthropic DashScope', [])).toBe(false);
  });
});
