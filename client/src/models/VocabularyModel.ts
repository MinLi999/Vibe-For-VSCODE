/**
 * Model layer: pure logic for context payload building — regex tokenizing, word frequency
 * ranking, filename-stem merging, caching, and the two-tier payload assembly
 * (ranked keywords for prompt biasing + rich projectContext for context-enhancement ASR).
 * Input is raw text/filenames handed in by the Viewer; this layer does not import vscode UI (02-STANDARDS §2).
 */

/** Authoritative regex (02-STANDARDS §3): 4-20 character identifiers. */
const IDENTIFIER_PATTERN = /[a-zA-Z_][a-zA-Z0-9_]{3,19}/g;

/** Ranked keyword budget: active-doc top slots + workspace top slots, filled to the cap with stems. */
const KEYWORD_CAP = 40;
const ACTIVE_DOC_KEYWORD_SLOTS = 20;
const WORKSPACE_KEYWORD_SLOTS = 15;

/** projectContext char budget (~500 tokens): rich free text for the ASR context-enhancement channel. */
const PROJECT_CONTEXT_MAX_CHARS = 2000;
const ACTIVE_DOC_SYMBOL_COUNT = 30;

/** Small stoplist of common language keywords/noise words — the ASR already knows these, not worth a slot. */
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
  activeDocumentKey?: string;
  /** Workspace-relative path of the active file, e.g. "src/controllers/VibeController.ts". */
  activeFilePath?: string;
  /** VS Code languageId of the active file, e.g. "typescript". */
  activeLanguageId?: string;
  /** Workspace (folder) name. */
  workspaceName?: string;
}

/** Two-tier context payload: ranked keywords (prompt biasing) + rich free text (context enhancement). */
export interface ContextPayload {
  keywords: string[];
  projectContext: string;
}

export class VocabularyModel {
  private docFreqCache = new Map<string, Map<string, number>>();

  private tokensOf(doc: DocumentContext, limit: number): string[] {
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
    return [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([token]) => token);
  }

  /**
   * Builds the two-tier context payload:
   * - keywords (≤40, ranked): active-doc top 20 → workspace top 15 → filename stems to fill.
   *   Consumed by the Whisper-path initial_prompt (800-byte budget applied at send time).
   * - projectContext (≤2000 chars): structured free text with original-casing identifiers.
   *   Consumed by the quality-tier ASR's context-enhancement channel (no tight budget).
   */
  buildPayload(input: EditorContextInput, workspaceKeywords: string[] = []): ContextPayload {
    this.pruneCache(input);

    const activeDoc = input.activeDocumentKey
      ? input.documents.find((d) => d.key === input.activeDocumentKey)
      : input.documents[0];
    const activeTokens = activeDoc ? this.tokensOf(activeDoc, ACTIVE_DOC_SYMBOL_COUNT) : [];
    const fileStems = input.fileNames
      .map((name) => stemOfFileName(name))
      .filter((stem): stem is string => stem !== null);

    // --- Tier 1: ranked keywords ---
    const seen = new Set<string>();
    const keywords: string[] = [];
    const addToken = (token: string): void => {
      const lower = token.toLowerCase();
      if (!seen.has(lower) && keywords.length < KEYWORD_CAP) {
        seen.add(lower);
        keywords.push(token);
      }
    };
    for (const t of activeTokens.slice(0, ACTIVE_DOC_KEYWORD_SLOTS)) {
      addToken(t);
    }
    for (const t of workspaceKeywords.slice(0, WORKSPACE_KEYWORD_SLOTS)) {
      addToken(t);
    }
    // Other open documents, then filename stems, fill the remaining slots.
    for (const doc of input.documents) {
      if (keywords.length >= KEYWORD_CAP) {
        break;
      }
      if (activeDoc && doc.key === activeDoc.key) {
        continue;
      }
      for (const t of this.tokensOf(doc, 10)) {
        addToken(t);
      }
    }
    for (const t of fileStems) {
      addToken(t);
    }

    // --- Tier 2: projectContext free text (assembled section-by-section under the char budget) ---
    const sections: string[] = [];
    if (input.workspaceName) {
      sections.push(`项目: ${input.workspaceName}`);
    }
    if (input.activeFilePath) {
      sections.push(`当前文件: ${input.activeFilePath}${input.activeLanguageId ? ` (${input.activeLanguageId})` : ''}`);
    }
    if (activeTokens.length > 0) {
      sections.push(`当前文件符号: ${activeTokens.join('、')}`);
    }
    if (workspaceKeywords.length > 0) {
      sections.push(`项目高频标识符: ${workspaceKeywords.join('、')}`);
    }
    if (fileStems.length > 0) {
      sections.push(`相关文件: ${fileStems.join('、')}`);
    }

    let projectContext = '';
    for (const section of sections) {
      const candidate = projectContext.length === 0 ? section : `${projectContext}\n${section}`;
      if (candidate.length > PROJECT_CONTEXT_MAX_CHARS) {
        break;
      }
      projectContext = candidate;
    }

    return { keywords, projectContext };
  }

  /** Drops cache entries for documents that are no longer open. */
  private pruneCache(input: EditorContextInput): void {
    const currentKeys = new Set(input.documents.map((d) => d.key));
    for (const key of this.docFreqCache.keys()) {
      if (!currentKeys.has(key)) {
        this.docFreqCache.delete(key);
      }
    }
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
