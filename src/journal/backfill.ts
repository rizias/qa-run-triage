import {
  normalizeEntry, readJournalLines, withJournalLock, writeJournalLines,
  type JournalEntry, type JournalLockOptions
} from './journal.js';

type Backfill = Pick<JournalEntry, 'env' | 'city' | 'server' | 'buildUrl'>;
import { sameRun } from './identity.js';

export function fillMissingRunFields(
  cacheDir: string, job: string, build: number, values: Backfill, options: JournalLockOptions
): boolean {
  return withJournalLock(cacheDir, (lock) => {
    const lines = readJournalLines(cacheDir);
    let filledEnv = false;
    let changed = false;
    const updated = lines.map((line) => {
      let current: JournalEntry;
      try {
        current = normalizeEntry(JSON.parse(line));
      } catch {
        return line;
      }
      if (!sameRun(current, { job, build, server: values.server }, options.resolveServer ?? (() => values.server))) return line;
      const raw = JSON.parse(line) as Record<string, unknown>;
      let lineChanged = false;
      for (const key of ['env', 'city', 'server', 'buildUrl'] as const) {
        if (!current[key] && values[key]) {
          raw[key] = values[key];
          lineChanged = true;
          if (key === 'env') filledEnv = true;
        }
      }
      changed ||= lineChanged;
      return lineChanged ? JSON.stringify(raw) : line;
    });
    if (changed) writeJournalLines(cacheDir, updated, lock);
    return filledEnv;
  }, options);
}
