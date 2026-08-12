/**
 * User dictionary: the large personal vocabulary behind the small ASR bias list.
 *
 * Three-layer design (docs/05-MAC-VOICE-INPUT.md §3):
 *   L1  selectAsrKeywords() picks the <=40 most relevant words per request for the ASR
 *       bias channel (the server-side keyword cap and isContextEcho guard stay untouched).
 *   L2  (rewrite-stage phonetic correction) is planned; not implemented here.
 *   L3  applyReplacements() runs deterministic local text replacement after transcription —
 *       unlimited capacity, zero tokens, works offline.
 *
 * Pure model — no electron/vscode/filesystem dependencies (shared by both frontends).
 * Persisted data is untrusted (hand-edited JSON, older versions) and sanitized on load.
 */

export type DictionarySource = 'manual' | 'learned' | 'contacts';

export interface DictionaryEntry {
  /** Canonical spelling — casing here is authoritative for corrections. */
  word: string;
  /** Common mis-hearings of this word (used by the future L2 correction layer). */
  aliases: string[];
  source: DictionarySource;
  /** Epoch ms when the entry was added. */
  addedAt: number;
  /** Epoch ms when the word last appeared in a transcription, or null if never. */
  lastUsedAt: number | null;
  /** How many transcriptions contained this word. */
  hits: number;
}

export interface ReplacementRule {
  /** Literal text to search for (matched case-insensitively unless caseSensitive). */
  from: string;
  /** Literal replacement text. */
  to: string;
  caseSensitive: boolean;
}

export interface DictionaryData {
  entries: DictionaryEntry[];
  replacements: ReplacementRule[];
}

export const DICTIONARY_ENTRY_CAP = 10000;
export const REPLACEMENT_RULE_CAP = 1000;
export const MAX_WORD_LENGTH = 64;
/** A usage hit outranks one day of pure recency when scoring ASR keyword candidates. */
const HIT_WEIGHT_MS = 24 * 60 * 60 * 1000;

const SOURCES: readonly DictionarySource[] = ['manual', 'learned', 'contacts'];

function normalizeWord(word: string): string {
  return word.trim().toLowerCase();
}

function isValidWord(word: string): boolean {
  const trimmed = word.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_WORD_LENGTH && !trimmed.includes('\n');
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class UserDictionary {
  private entries: DictionaryEntry[];
  private replacements: ReplacementRule[];

  constructor(initial: unknown = undefined, private readonly cap = DICTIONARY_ENTRY_CAP) {
    const data = UserDictionary.sanitize(initial, cap);
    this.entries = data.entries;
    this.replacements = data.replacements;
  }

  private static sanitize(raw: unknown, cap: number): DictionaryData {
    const out: DictionaryData = { entries: [], replacements: [] };
    if (typeof raw !== 'object' || raw === null) {
      return out;
    }
    const data = raw as Partial<Record<'entries' | 'replacements', unknown>>;
    const seen = new Set<string>();
    if (Array.isArray(data.entries)) {
      for (const item of data.entries) {
        if (out.entries.length >= cap || typeof item !== 'object' || item === null) {
          continue;
        }
        const e = item as Partial<DictionaryEntry>;
        if (typeof e.word !== 'string' || !isValidWord(e.word)) {
          continue;
        }
        const key = normalizeWord(e.word);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        out.entries.push({
          word: e.word.trim(),
          aliases: Array.isArray(e.aliases)
            ? e.aliases.filter((a): a is string => typeof a === 'string' && isValidWord(a)).map((a) => a.trim()).slice(0, 8)
            : [],
          source: SOURCES.includes(e.source as DictionarySource) ? (e.source as DictionarySource) : 'manual',
          addedAt: typeof e.addedAt === 'number' && Number.isFinite(e.addedAt) ? e.addedAt : 0,
          lastUsedAt: typeof e.lastUsedAt === 'number' && Number.isFinite(e.lastUsedAt) ? e.lastUsedAt : null,
          hits: typeof e.hits === 'number' && Number.isFinite(e.hits) && e.hits > 0 ? Math.floor(e.hits) : 0,
        });
      }
    }
    if (Array.isArray(data.replacements)) {
      for (const item of data.replacements) {
        if (out.replacements.length >= REPLACEMENT_RULE_CAP || typeof item !== 'object' || item === null) {
          continue;
        }
        const r = item as Partial<ReplacementRule>;
        if (typeof r.from !== 'string' || typeof r.to !== 'string' || !isValidWord(r.from) || r.to.length > 2000) {
          continue;
        }
        out.replacements.push({ from: r.from.trim(), to: r.to, caseSensitive: r.caseSensitive === true });
      }
    }
    return out;
  }

  get size(): number {
    return this.entries.length;
  }

  listEntries(): readonly DictionaryEntry[] {
    return this.entries;
  }

  listReplacements(): readonly ReplacementRule[] {
    return this.replacements;
  }

  findEntry(word: string): DictionaryEntry | undefined {
    const key = normalizeWord(word);
    return this.entries.find((e) => normalizeWord(e.word) === key);
  }

  /** Returns false for invalid words and case-insensitive duplicates (existing entry wins). */
  addEntry(word: string, opts: { aliases?: string[]; source?: DictionarySource; now?: number } = {}): boolean {
    if (!isValidWord(word) || this.entries.length >= this.cap || this.findEntry(word) !== undefined) {
      return false;
    }
    this.entries.push({
      word: word.trim(),
      aliases: (opts.aliases ?? []).filter(isValidWord).map((a) => a.trim()).slice(0, 8),
      source: opts.source ?? 'manual',
      addedAt: opts.now ?? Date.now(),
      lastUsedAt: null,
      hits: 0,
    });
    return true;
  }

  /** Replaces word/aliases of an existing entry; usage stats survive the edit. */
  updateEntry(originalWord: string, patch: { word?: string; aliases?: string[] }): boolean {
    const entry = this.findEntry(originalWord);
    if (entry === undefined) {
      return false;
    }
    if (patch.word !== undefined) {
      if (!isValidWord(patch.word)) {
        return false;
      }
      const collision = this.findEntry(patch.word);
      if (collision !== undefined && collision !== entry) {
        return false;
      }
      entry.word = patch.word.trim();
    }
    if (patch.aliases !== undefined) {
      entry.aliases = patch.aliases.filter(isValidWord).map((a) => a.trim()).slice(0, 8);
    }
    return true;
  }

  removeEntry(word: string): boolean {
    const key = normalizeWord(word);
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => normalizeWord(e.word) !== key);
    return this.entries.length < before;
  }

  addReplacement(rule: { from: string; to: string; caseSensitive?: boolean }): boolean {
    if (!isValidWord(rule.from) || rule.to.length > 2000 || this.replacements.length >= REPLACEMENT_RULE_CAP) {
      return false;
    }
    const key = normalizeWord(rule.from);
    if (this.replacements.some((r) => normalizeWord(r.from) === key)) {
      return false;
    }
    this.replacements.push({ from: rule.from.trim(), to: rule.to, caseSensitive: rule.caseSensitive === true });
    return true;
  }

  removeReplacement(from: string): boolean {
    const key = normalizeWord(from);
    const before = this.replacements.length;
    this.replacements = this.replacements.filter((r) => normalizeWord(r.from) !== key);
    return this.replacements.length < before;
  }

  /**
   * L1: the <=limit words most worth spending ASR bias slots on right now.
   * Score = recency (lastUsedAt, falling back to addedAt so fresh manual adds rank high,
   * since the user just added them BECAUSE they get mis-heard) + hits weighted at one
   * day per hit. Deterministic given the stored timestamps.
   */
  selectAsrKeywords(limit: number): string[] {
    const scored = this.entries
      .map((e) => ({ word: e.word, score: Math.max(e.lastUsedAt ?? 0, e.addedAt) + e.hits * HIT_WEIGHT_MS }))
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(0, limit)).map((s) => s.word);
  }

  /** L3: deterministic literal replacement, longest pattern first so overlaps resolve stably. */
  applyReplacements(text: string): string {
    let out = text;
    const rules = [...this.replacements].sort((a, b) => b.from.length - a.from.length);
    for (const rule of rules) {
      const pattern = new RegExp(escapeRegExp(rule.from), rule.caseSensitive ? 'g' : 'gi');
      out = out.replace(pattern, () => rule.to); // Function form: `$` in `to` stays literal.
    }
    return out;
  }

  /** Bumps hits/lastUsedAt for every entry whose word appears in the delivered text. */
  recordUsage(text: string, now: number = Date.now()): boolean {
    const haystack = text.toLowerCase();
    let touched = false;
    for (const entry of this.entries) {
      if (haystack.includes(entry.word.toLowerCase())) {
        entry.hits += 1;
        entry.lastUsedAt = now;
        touched = true;
      }
    }
    return touched;
  }

  /** Merges another dictionary export; existing entries win. Returns how many were added. */
  importData(raw: unknown): number {
    const incoming = UserDictionary.sanitize(raw, this.cap);
    let added = 0;
    for (const entry of incoming.entries) {
      if (this.entries.length >= this.cap || this.findEntry(entry.word) !== undefined) {
        continue;
      }
      this.entries.push(entry);
      added += 1;
    }
    for (const rule of incoming.replacements) {
      if (this.addReplacement(rule)) {
        added += 1;
      }
    }
    return added;
  }

  toJSON(): DictionaryData {
    return { entries: this.entries, replacements: this.replacements };
  }
}
