import { describe, expect, it } from 'vitest';

import { UserDictionary } from './UserDictionary';

describe('UserDictionary', () => {
  it('sanitizes corrupted persisted data', () => {
    const dict = new UserDictionary({
      entries: [
        { word: 'Claude Code', aliases: ['克劳德'], source: 'manual', addedAt: 1, lastUsedAt: null, hits: 2 },
        { word: '', source: 'manual' }, // invalid: empty
        { word: 'claude code' }, // case-insensitive duplicate of the first
        'not-an-object',
        { word: 'x'.repeat(100) }, // invalid: too long
        { word: 'DashScope', hits: -5, addedAt: 'nope' }, // fields healed
      ],
      replacements: [
        { from: 'at sign', to: '@', caseSensitive: false },
        { from: '', to: 'x' }, // invalid
      ],
    });
    expect(dict.listEntries().map((e) => e.word)).toEqual(['Claude Code', 'DashScope']);
    expect(dict.findEntry('dashscope')?.hits).toBe(0);
    expect(dict.findEntry('dashscope')?.addedAt).toBe(0);
    expect(dict.listReplacements()).toHaveLength(1);
  });

  it('rejects case-insensitive duplicate adds and keeps the existing casing', () => {
    const dict = new UserDictionary();
    expect(dict.addEntry('useEffect', { now: 10 })).toBe(true);
    expect(dict.addEntry('USEEFFECT', { now: 20 })).toBe(false);
    expect(dict.findEntry('useeffect')?.word).toBe('useEffect');
  });

  it('selectAsrKeywords ranks fresh manual adds and frequently used words above stale ones', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const dict = new UserDictionary();
    dict.addEntry('StaleWord', { now: 1 * DAY });
    dict.addEntry('FreshAdd', { now: 10 * DAY });
    dict.addEntry('HeavyUse', { now: 2 * DAY });
    // 5 hits => +5 days of score on top of lastUsedAt 3*DAY = 8 days total, beating StaleWord.
    for (let i = 0; i < 5; i++) {
      dict.recordUsage('we said HeavyUse here', 3 * DAY);
    }
    expect(dict.selectAsrKeywords(2)).toEqual(['FreshAdd', 'HeavyUse']);
    expect(dict.selectAsrKeywords(0)).toEqual([]);
  });

  it('applyReplacements is case-insensitive by default, literal, and longest-first', () => {
    const dict = new UserDictionary();
    dict.addReplacement({ from: 'at sign', to: '@' });
    dict.addReplacement({ from: 'at sign email', to: 'a@b.com' });
    dict.addReplacement({ from: 'c++', to: 'C++' }); // regex specials must stay literal
    expect(dict.applyReplacements('my At Sign Email please')).toBe('my a@b.com please');
    expect(dict.applyReplacements('learn c++ today')).toBe('learn C++ today');
    expect(dict.applyReplacements('dollar $1 stays')).toBe('dollar $1 stays');
  });

  it('recordUsage bumps hits and lastUsedAt only for words present in the text', () => {
    const dict = new UserDictionary();
    dict.addEntry('VibeFox', { now: 1 });
    dict.addEntry('Redis', { now: 1 });
    expect(dict.recordUsage('deploy vibefox now', 99)).toBe(true);
    expect(dict.findEntry('VibeFox')?.hits).toBe(1);
    expect(dict.findEntry('VibeFox')?.lastUsedAt).toBe(99);
    expect(dict.findEntry('Redis')?.hits).toBe(0);
  });

  it('importData merges without clobbering existing entries and reports the added count', () => {
    const dict = new UserDictionary();
    dict.addEntry('Claude', { now: 1 });
    const added = dict.importData({
      entries: [
        { word: 'claude', addedAt: 2 }, // duplicate — skipped
        { word: 'Qwen', addedAt: 2 },
      ],
      replacements: [{ from: 'at sign', to: '@' }],
    });
    expect(added).toBe(2);
    expect(dict.size).toBe(2);
    expect(dict.listReplacements()).toHaveLength(1);
  });

  it('updateEntry renames in place, preserves stats, and refuses collisions', () => {
    const dict = new UserDictionary();
    dict.addEntry('Posgres', { now: 1 });
    dict.addEntry('Redis', { now: 1 });
    dict.recordUsage('Posgres is here', 5);
    expect(dict.updateEntry('posgres', { word: 'PostgreSQL', aliases: ['Posgres'] })).toBe(true);
    expect(dict.findEntry('PostgreSQL')?.hits).toBe(1);
    expect(dict.updateEntry('PostgreSQL', { word: 'redis' })).toBe(false);
  });
});
