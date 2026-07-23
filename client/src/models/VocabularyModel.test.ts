import { describe, expect, it } from 'vitest';
import { VocabularyModel, type EditorContextInput } from './VocabularyModel';

const input: EditorContextInput = {
  documents: [
    {
      key: 'doc1',
      text: 'function processUtterance() { const dedupeAgainstSession = 1; processUtterance(); }',
    },
  ],
  fileNames: ['VibeController.ts'],
  activeDocumentKey: 'doc1',
  workspaceName: 'demo',
};

describe('VocabularyModel.buildPayload — personal dictionary', () => {
  it('puts personal-dictionary entries ahead of mined identifiers', () => {
    const payload = new VocabularyModel().buildPayload(input, ['workspaceWord'], ['Anthropic', 'wrangler']);
    expect(payload.keywords.slice(0, 2)).toEqual(['Anthropic', 'wrangler']);
    expect(payload.keywords).toContain('processUtterance');
  });

  it('deduplicates case-insensitively against mined identifiers', () => {
    const payload = new VocabularyModel().buildPayload(input, [], ['PROCESSUTTERANCE']);
    // The dictionary spelling wins the slot; the mined variant must not appear again.
    expect(payload.keywords.filter((k) => k.toLowerCase() === 'processutterance')).toHaveLength(1);
    expect(payload.keywords[0]).toBe('PROCESSUTTERANCE');
  });

  it('is a no-op when the dictionary is empty', () => {
    const payload = new VocabularyModel().buildPayload(input, [], []);
    expect(payload.keywords).toContain('processUtterance');
  });
});
