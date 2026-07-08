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

export interface EditorContextInput {
  /** Full text of the active editor (may be null, e.g. focus is on a chat panel). */
  documentText: string | null;
  /** Cache-invalidation key: document URI + version. */
  documentKey: string | null;
  /** Recent workspace filenames (with extension). */
  fileNames: string[];
}

export class VocabularyModel {
  private cachedKey: string | null = null;
  private cachedTokens: string[] = [];

  /**
   * Extracts top-40 identifiers + filename stems, returning a deduplicated vocabulary
   * (injected as `keywords` in the API request).
   */
  extractKeywords(input: EditorContextInput): string[] {
    const documentTokens = this.tokensForDocument(input);
    const fileStems = input.fileNames
      .map((name) => stemOfFileName(name))
      .filter((stem): stem is string => stem !== null);

    // Document tokens take priority (most relevant to spoken content); filename stems fill in; dedupe overall.
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const token of [...documentTokens, ...fileStems]) {
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

  /** Cached by documentKey (URI+version); doesn't re-scan the same document version. */
  private tokensForDocument(input: EditorContextInput): string[] {
    if (input.documentText === null || input.documentKey === null) {
      return [];
    }
    if (input.documentKey === this.cachedKey) {
      return this.cachedTokens;
    }

    const frequency = new Map<string, number>();
    for (const match of input.documentText.matchAll(IDENTIFIER_PATTERN)) {
      const token = match[0];
      if (STOP_WORDS.has(token.toLowerCase())) {
        continue;
      }
      frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }

    const top = [...frequency.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_TOKEN_COUNT)
      .map(([token]) => token);

    this.cachedKey = input.documentKey;
    this.cachedTokens = top;
    return top;
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
