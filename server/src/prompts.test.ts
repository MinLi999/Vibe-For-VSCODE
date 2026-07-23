import { describe, expect, it } from 'vitest';
import { CLEAN_SYSTEM_PROMPT, REWRITE_SYSTEM_PROMPT, withAppTone, withChineseVariant } from './prompts';

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
