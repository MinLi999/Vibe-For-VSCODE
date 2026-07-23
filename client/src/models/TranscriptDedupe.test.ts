import { describe, expect, it } from 'vitest';
import { dedupeAgainstSession } from './TranscriptDedupe';

describe('dedupeAgainstSession', () => {
  it('returns the text untouched when the session is empty', () => {
    expect(dedupeAgainstSession('', '你现在需要调整几点')).toBe('你现在需要调整几点');
  });

  it('drops a full re-emission of what the session already inserted (2026-07-12 regression)', () => {
    const session = '你现在需要调整几点,第一个是登录超时的问题。';
    expect(dedupeAgainstSession(session, '你现在需要调整几点,第一个是登录超时的问题。')).toBe('');
    // Echo detection ignores punctuation/whitespace variance between the two copies.
    expect(dedupeAgainstSession(session, '你现在需要调整几点 第一个是登录超时的问题')).toBe('');
  });

  it('trims a >=8-char suffix/prefix overlap and strips the leftover leading punctuation', () => {
    const session = '接下来我们重构 AudioRecorderService';
    expect(dedupeAgainstSession(session, 'AudioRecorderService needs a retry')).toBe('needs a retry');
  });

  it('keeps short repeats — ordinary word repetition is not an echo', () => {
    expect(dedupeAgainstSession('好的继续', '继续吧')).toBe('继续吧');
  });

  it('keeps genuinely new text', () => {
    const session = '第一步先安装依赖。';
    expect(dedupeAgainstSession(session, '第二步配置环境变量')).toBe('第二步配置环境变量');
  });
});
