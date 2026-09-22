import { normalizeEntry, readJournalLines, serializeJournalEntry, type JournalEntry } from './journal.js';
import { runKey, type ResolveRunServer } from './identity.js';

export function rewriteLines(cacheDir: string, entries: JournalEntry[], resolveServer?: ResolveRunServer): string[] {
  const repaired = new Map(entries.map((entry) => [runKey(entry, resolveServer), entry]));
  const emitted = new Set<string>();
  const lines: string[] = [];
  for (const line of readJournalLines(cacheDir)) {
    let parsed: JournalEntry;
    try {
      parsed = normalizeEntry(JSON.parse(line));
    } catch {
      lines.push(line);
      continue;
    }
    const key = runKey(parsed, resolveServer);
    const entry = repaired.get(key);
    if (entry === undefined || emitted.has(key)) continue;
    emitted.add(key);
    const serialized = serializeJournalEntry(entry);
    lines.push(serialized === serializeJournalEntry(parsed) ? line : serialized);
  }
  return lines;
}
