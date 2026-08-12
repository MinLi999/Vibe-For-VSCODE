/**
 * Local usage stats (stats.json next to config.json): cumulative characters/sessions plus a
 * per-day breakdown for the settings window's home tab. Local-only, same privacy contract as
 * the transcription history.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface DayStats {
  chars: number;
  sessions: number;
}

export interface UsageStats {
  totalChars: number;
  totalSessions: number;
  /** Keyed by local date "YYYY-MM-DD"; pruned to the most recent 90 days. */
  days: Record<string, DayStats>;
}

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAYS_KEPT = 90;

export function emptyStats(): UsageStats {
  return { totalChars: 0, totalSessions: 0, days: {} };
}

/** Local-timezone day key — usage should roll over at the user's midnight, not UTC's. */
export function dayKey(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

function sanitize(raw: unknown): UsageStats {
  const out = emptyStats();
  if (typeof raw !== 'object' || raw === null) {
    return out;
  }
  const data = raw as Partial<UsageStats>;
  out.totalChars = typeof data.totalChars === 'number' && data.totalChars >= 0 ? Math.floor(data.totalChars) : 0;
  out.totalSessions = typeof data.totalSessions === 'number' && data.totalSessions >= 0 ? Math.floor(data.totalSessions) : 0;
  if (typeof data.days === 'object' && data.days !== null) {
    for (const [key, value] of Object.entries(data.days)) {
      const day = value as Partial<DayStats>;
      if (DAY_KEY_PATTERN.test(key) && typeof day?.chars === 'number' && typeof day?.sessions === 'number') {
        out.days[key] = { chars: Math.max(0, Math.floor(day.chars)), sessions: Math.max(0, Math.floor(day.sessions)) };
      }
    }
  }
  return out;
}

function prune(stats: UsageStats): void {
  const keys = Object.keys(stats.days).sort();
  for (const key of keys.slice(0, Math.max(0, keys.length - DAYS_KEPT))) {
    delete stats.days[key];
  }
}

export function statsFilePath(userDataDir: string): string {
  return path.join(userDataDir, 'stats.json');
}

export function loadStats(userDataDir: string): UsageStats {
  try {
    return sanitize(JSON.parse(fs.readFileSync(statsFilePath(userDataDir), 'utf8')));
  } catch {
    return emptyStats();
  }
}

export function saveStats(userDataDir: string, stats: UsageStats): void {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(statsFilePath(userDataDir), JSON.stringify(stats, null, 2) + '\n', 'utf8');
  } catch {
    /* Best effort. */
  }
}

/** Adds one finished recording session's character count to the running totals. */
export function recordSession(stats: UsageStats, chars: number, when: Date = new Date()): void {
  stats.totalChars += chars;
  stats.totalSessions += 1;
  const key = dayKey(when);
  const day = stats.days[key] ?? { chars: 0, sessions: 0 };
  day.chars += chars;
  day.sessions += 1;
  stats.days[key] = day;
  prune(stats);
}
