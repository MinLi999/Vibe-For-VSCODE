import { describe, expect, it } from 'vitest';
import { TranscriptHistory } from './TranscriptHistory';

describe('TranscriptHistory', () => {
  it('lists newest first and caps at the limit', () => {
    const h = new TranscriptHistory([], 3);
    h.add('one', 1);
    h.add('two', 2);
    h.add('three', 3);
    h.add('four', 4);
    expect(h.list().map((e) => e.text)).toEqual(['four', 'three', 'two']);
    expect(h.size).toBe(3);
  });

  it('ignores empty/whitespace additions', () => {
    const h = new TranscriptHistory();
    h.add('   ');
    expect(h.size).toBe(0);
  });

  it('round-trips through JSON persistence', () => {
    const h = new TranscriptHistory();
    h.add('修复 AudioRecorderService 的重试逻辑', 100);
    const revived = new TranscriptHistory(JSON.parse(JSON.stringify(h.toJSON())));
    expect(revived.list()).toEqual([{ at: 100, text: '修复 AudioRecorderService 的重试逻辑' }]);
  });

  it('sanitizes corrupted persisted data instead of crashing', () => {
    expect(new TranscriptHistory('garbage').size).toBe(0);
    expect(new TranscriptHistory([{ at: 'nope' }, null, { at: 1, text: 'ok' }, { at: 2, text: '' }]).size).toBe(1);
  });
});
