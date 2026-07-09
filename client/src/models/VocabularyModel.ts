/**
 * Model layer: pure logic for context vocabulary extraction — regex tokenizing,
 * top-40 word frequency, filename-stem merging, caching.
 * Input is raw text/filenames handed in by the Viewer; this layer does not import vscode UI (02-STANDARDS §2).
 */

/** Authoritative regex (02-STANDARDS §3): 4-20 character identifiers. */
const IDENTIFIER_PATTERN = /[a-zA-Z_][a-zA-Z0-9_]{3,19}/g;

const TOP_TOKEN_COUNT = 40;

/** Small stoplist of common language keywords/noise words — Whisper already knows these, not worth a prompt slot. */
const STOP_WORDS = new Set([
  'this', 'that', 'then', 'else', 'true', 'false', 'null', 'undefined',
  'function', 'return', 'const', 'import', 'export', 'from', 'default',
  'async', 'await', 'class', 'interface', 'type', 'enum', 'extends',
  'implements', 'public', 'private', 'protected', 'static', 'readonly',
  'void', 'never', 'string', 'number', 'boolean', 'object', 'symbol',
  'while', 'break', 'continue', 'switch', 'case', 'throw', 'catch',
  'finally', 'typeof', 'instanceof', 'delete', 'yield', 'super', 'with',
  'self', 'none', 'elif', 'pass', 'lambda', 'print', 'range',
]);

export interface DocumentContext {
  text: string;
  key: string;
}

export interface EditorContextInput {
  /** All currently opened text documents in the workspace. */
  documents: DocumentContext[];
  /** Recent workspace filenames (with extension). */
  fileNames: string[];
}

export class VocabularyModel {
  private docFreqCache = new Map<string, Map<string, number>>();

  /**
   * Extracts top-40 identifiers + workspace keywords + filename stems, returning a deduplicated vocabulary
   * (injected as `keywords` in the API request).
   */
  extractKeywords(input: EditorContextInput, workspaceKeywords: string[] = []): string[] {
    const documentTokens = this.tokensAcrossDocuments(input);
    const fileStems = input.fileNames
      .map((name) => stemOfFileName(name))
      .filter((stem): stem is string => stem !== null);

    // Document tokens take priority (most relevant to spoken content); then workspace keywords (global project vocabulary); then filename stems fill in; dedupe overall.
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const token of [...documentTokens, ...workspaceKeywords, ...fileStems]) {
      const lower = token.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        merged.push(token);
      }
    }
    return merged;
  }

  /** Vocabulary → human-readable hint string (for status bar tooltip / logging). */
  formatHint(keywords: string[]): string {
    return keywords.length === 0 ? '' : `context vocabulary: ${keywords.join(', ')}`;
  }

  /** Cached by document key (URI+version); merging frequencies across all open documents. */
  private tokensAcrossDocuments(input: EditorContextInput): string[] {
    const currentKeys = new Set(input.documents.map((d) => d.key));
    // Clean up closed/changed documents
    for (const key of this.docFreqCache.keys()) {
      if (!currentKeys.has(key)) {
        this.docFreqCache.delete(key);
      }
    }

    const globalFreq = new Map<string, number>();

    for (const doc of input.documents) {
      let freq = this.docFreqCache.get(doc.key);
      if (freq === undefined) {
        freq = new Map<string, number>();
        for (const match of doc.text.matchAll(IDENTIFIER_PATTERN)) {
          const token = match[0];
          if (STOP_WORDS.has(token.toLowerCase())) {
            continue;
          }
          freq.set(token, (freq.get(token) ?? 0) + 1);
        }
        this.docFreqCache.set(doc.key, freq);
      }
      for (const [token, count] of freq.entries()) {
        globalFreq.set(token, (globalFreq.get(token) ?? 0) + count);
      }
    }

    return [...globalFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_TOKEN_COUNT)
      .map(([token]) => token);
  }
}

/** e.g. `AudioRecorderService.test.ts` → `AudioRecorderService`; drops stems that are all-numeric or too short. */
function stemOfFileName(name: string): string | null {
  const base = name.split('/').pop() ?? name;
  const stem = base.split('.')[0] ?? '';
  if (stem.length < 4 || !/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(stem)) {
    return null;
  }
  return stem;
}
