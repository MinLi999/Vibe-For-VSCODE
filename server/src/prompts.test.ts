import { describe, expect, it } from 'vitest';
import { buildRewriteUserMessage, CLEAN_SYSTEM_PROMPT, REWRITE_SYSTEM_PROMPT, withAppTone, withChineseVariant } from './prompts';

describe('withAppTone', () => {
  it('is a no-op for ide/terminal/other and unknown categories', () => {
    expect(withAppTone(REWRITE_SYSTEM_PROMPT, 'ide')).toBe(REWRITE_SYSTEM_PROMPT);
    expect(withAppTone(REWRITE_SYSTEM_PROMPT, 'terminal')).toBe(REWRITE_SYSTEM_PROMPT);
    expect(withAppTone(REWRITE_SYSTEM_PROMPT, 'other')).toBe(REWRITE_SYSTEM_PROMPT);
    expect(withAppTone(REWRITE_SYSTEM_PROMPT, undefined)).toBe(REWRITE_SYSTEM_PROMPT);
  });

  it('appends a tone instruction for chat/email/notes without touching the base rules', () => {
    for (const category of ['chat', 'email', 'notes'] as const) {
      const prompt = withAppTone(CLEAN_SYSTEM_PROMPT, category);
      expect(prompt.startsWith(CLEAN_SYSTEM_PROMPT)).toBe(true);
      expect(prompt.length).toBeGreaterThan(CLEAN_SYSTEM_PROMPT.length);
      // The tone hint must stay subordinate to the core rules.
      expect(prompt).toContain('不违反上述任何规则');
    }
  });

  it('stacks with the Chinese-variant instruction', () => {
    const prompt = withAppTone(withChineseVariant(REWRITE_SYSTEM_PROMPT, 'traditional-tw'), 'email');
    expect(prompt.startsWith(REWRITE_SYSTEM_PROMPT)).toBe(true);
    expect(prompt).toContain('繁体字');
    expect(prompt).toContain('邮件正文');
  });
});

describe('rewrite prompt structure rules', () => {
  it('keeps the empty-string rule as the LAST numbered rule (rule 0 refers to "最后一条")', () => {
    const lastRuleMatch = REWRITE_SYSTEM_PROMPT.trimEnd().split('\n').filter((l) => /^\d+\./.test(l)).pop();
    expect(lastRuleMatch).toContain('空字符串规则');
  });

  it('contains the spoken-enumeration list formatting rule', () => {
    expect(REWRITE_SYSTEM_PROMPT).toContain('逐行编号列表');
    // clean mode must NOT restructure — the list rule belongs to rewrite only.
    expect(CLEAN_SYSTEM_PROMPT).not.toContain('逐行编号列表');
  });
});

/**
 * Cost-critical: DashScope's implicit context cache is prefix-matched and bills hits at 20%
 * of the input price. ~88% of every rewrite request is the fixed prefix (system prompt +
 * keywords + projectContext), and keywords are built once per recording session — so
 * consecutive segments MUST share a byte-identical prefix. Breaking that raises the rewrite
 * bill ~30% with no functional symptom, which is exactly the kind of regression a test has to
 * catch. See buildRewriteUserMessage's doc comment.
 */
describe('rewrite prompt cache prefix (cost guard)', () => {
  const keywords = ['useEffect', 'DashScope', 'Cloudflare Workers'];
  const projectContext = '用户是程序员,正在用语音向 AI 编程助手口述编程指令。';

  it('two segments of one session differ ONLY by a suffix', () => {
    const a = buildRewriteUserMessage('第一段说的内容', keywords, projectContext);
    const b = buildRewriteUserMessage('第二段说的完全不同的内容,长度也不一样', keywords, projectContext);

    let shared = 0;
    while (shared < a.length && shared < b.length && a[shared] === b[shared]) {
      shared++;
    }
    // Everything up to the transcript marker must be identical between the two.
    const marker = '待处理转写：';
    expect(a.slice(0, shared)).toContain(marker.slice(0, 3));
    expect(shared).toBeGreaterThanOrEqual(a.indexOf(marker) + marker.length);
  });

  it('the transcript is LAST — nothing per-request precedes the stable parts', () => {
    const message = buildRewriteUserMessage('转写内容', keywords, projectContext);
    expect(message.indexOf('参考词表')).toBeLessThan(message.indexOf('项目背景'));
    expect(message.indexOf('项目背景')).toBeLessThan(message.indexOf('待处理转写'));
    expect(message.endsWith('转写内容')).toBe(true);
  });

  it('the fixed prefix clears the 256-token cache threshold with wide margin', () => {
    const systemPrompt = withAppTone(withChineseVariant(CLEAN_SYSTEM_PROMPT, 'simplified-cn'), 'ide');
    const prefix = systemPrompt + buildRewriteUserMessage('x', keywords, projectContext);
    const cjk = (prefix.match(/[一-鿿]/g) ?? []).length;
    const approxTokens = cjk + (prefix.length - cjk) / 4;
    // Roughly 1 token per CJK char, 4 ASCII chars per token; 256 is DashScope's minimum.
    expect(approxTokens).toBeGreaterThan(1000);
  });

  it('the system prompt itself carries nothing per-request (no timestamps/ids)', () => {
    const first = withAppTone(withChineseVariant(REWRITE_SYSTEM_PROMPT, 'traditional-tw'), 'chat');
    const second = withAppTone(withChineseVariant(REWRITE_SYSTEM_PROMPT, 'traditional-tw'), 'chat');
    expect(first).toBe(second); // Byte-identical across calls => cacheable.
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}/); // No date slipped into the prompt.
  });
});
