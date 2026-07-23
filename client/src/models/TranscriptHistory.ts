/**
 * Local transcription history: the last N final texts this device inserted, newest first.
 * Privacy contract (README): history NEVER leaves the machine — the extension persists it in
 * VS Code globalState, the desktop app in a JSON file next to config.json. Pure model — no
 * vscode/electron dependencies (shared by both frontends).
 */

export interface TranscriptHistoryEntry {
  /** Epoch milliseconds of the insertion. */
  at: number;
  /** The final (rewritten) text that was inserted. */
  text: string;
}

export const HISTORY_CAP = 50;

export class TranscriptHistory {
  private entries: TranscriptHistoryEntry[];

  /** `initial` is untrusted persisted data (old versions, hand-edited files) — sanitized here. */
  constructor(initial: unknown = [], private readonly cap = HISTORY_CAP) {
    this.entries = TranscriptHistory.sanitize(initial, cap);
  }

  private static sanitize(data: unknown, cap: number): TranscriptHistoryEntry[] {
    if (!Array.isArray(data)) {
      return [];
    }
    return data
      .filter(
        (e): e is TranscriptHistoryEntry =>
          typeof e === 'object' && e !== null &&
          typeof (e as TranscriptHistoryEntry).at === 'number' &&
          typeof (e as TranscriptHistoryEntry).text === 'string' &&
          (e as TranscriptHistoryEntry).text.length > 0,
      )
      .slice(-cap);
  }

  add(text: string, at = Date.now()): void {
    const t = text.trim();
    if (t.length === 0) {
      return;
    }
    this.entries.push({ at, text: t });
    if (this.entries.length > this.cap) {
      this.entries = this.entries.slice(-this.cap);
    }
  }

  /** Newest first (display order). */
  list(): TranscriptHistoryEntry[] {
    return [...this.entries].reverse();
  }

  get size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }

  /** Oldest-first storage order, safe to JSON.stringify. */
  toJSON(): TranscriptHistoryEntry[] {
    return [...this.entries];
  }
}
