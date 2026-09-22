import { constants, copyFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { reportDir, runDir } from '../fetcher/cachePaths.js';
import { listFailures } from '../digest/failures.js';
import { readMainRecords } from '../report/read.js';
import type { JournalLock, JournalLockOptions } from './journal.js';
import {
  readEntries,
  withJournalLock,
  writeJournalLines,
  type JournalEntry
} from './journal.js';
import { fillRunRefs } from './runRefs.js';
import { runKey, type ResolveRunServer } from './identity.js';
import { cachedRunMatches } from '../fetcher/cacheServer.js';
import { rewriteLines } from './repairLines.js';

export interface RepairResult {
  updated: number;
  enriched: number;
  duplicatesRemoved: number;
  skipped: number;
  skippedReasons: Record<string, number>;
}

export type ResolveBuildUrl = (job: string, build: number, server?: string) => string | null;

export interface RepairOptions extends JournalLockOptions {
  baseUrl?: (server: string) => string | undefined;
}

export function repairJournal(
  cacheDir: string,
  resolveBuildUrl: ResolveBuildUrl = () => null,
  warn: (message: string) => void = console.warn,
  lockOptions: RepairOptions = {}
): RepairResult {
  return withJournalLock(
    cacheDir,
    (lock) => repairUnderLock(cacheDir, resolveBuildUrl, warn, lock, lockOptions),
    lockOptions
  );
}

function repairUnderLock(
  cacheDir: string,
  resolveBuildUrl: ResolveBuildUrl,
  warn: (message: string) => void,
  lock: JournalLock,
  options: RepairOptions
): RepairResult {
  const journalPath = path.join(cacheDir, 'journal.jsonl');
  const read = readEntries(cacheDir);
  const result: RepairResult = {
    updated: 0,
    enriched: 0,
    duplicatesRemoved: 0,
    skipped: 0,
    skippedReasons: {}
  };
  if (read.brokenLines.length > 0) {
    skip(result, 'битые строки', read.brokenLines.length);
    warn(`Предупреждение: непонятные строки журнала сохранены без изменений: ${read.brokenLines.length}.`);
  }

  const entries = collapseDuplicates(read.entries, result, options.resolveServer);
  let changed = result.duplicatesRemoved > 0;

  for (const entry of entries) {
    const candidate = { ...entry };
    try {
      const server = entry.server ?? options.resolveServer?.(entry.job);
      if (!cachedRunMatches(cacheDir, entry.job, entry.build, server, server ? options.baseUrl?.(server) : undefined)) {
        throw new Error('кэш принадлежит другому серверу или подключению');
      }
      const filled = processEntry(cacheDir, candidate, resolveBuildUrl, warn, result);
      if (filled) {
        if (candidate.server === undefined && server !== undefined) candidate.server = server;
        Object.assign(entry, candidate);
        changed = true;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warn(`Предупреждение: ${entry.job} #${entry.build} пропущен (${reason}).`);
      skip(result, reason);
    }
  }

  if (changed) {
    backupJournal(journalPath);
    writeJournalLines(cacheDir, rewriteLines(cacheDir, entries, options.resolveServer), lock);
  }

  return result;
}

function backupJournal(file: string): void {
  let timestamp = Date.now();
  for (;;) {
    const suffix = new Date(timestamp).toISOString().replace(/:/g, '-');
    try {
      copyFileSync(file, `${file}.bak-${suffix}`, constants.COPYFILE_EXCL);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      timestamp += 1;
    }
  }
}

function readCachedMeta(cacheDir: string, entry: JournalEntry, warn: (message: string) => void, result: RepairResult): CachedMeta | null {
  const runRoot = runDir(cacheDir, entry.job, entry.build);
  const metaFile = path.join(runRoot, 'meta.json');
  if (!existsSync(metaFile)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(metaFile, 'utf8')) as CachedMeta;
  } catch {
    warn(`Предупреждение: ${entry.job} #${entry.build} пропущен (битый meta.json).`);
    skip(result, 'битый meta.json');
    return null;
  }
}

function updateFingerprints(
  cacheDir: string,
  entry: JournalEntry,
  warn: (message: string) => void,
  result: RepairResult
): boolean {
  if (!entry.testsRan) {
    const legacyChanged = markLegacy(entry);
    skip(result, 'testsRan=false');
    return legacyChanged;
  }

  const report = reportDir(cacheDir, entry.job, entry.build);
  if (!existsSync(report)) {
    const reason = 'нет каталога отчёта';
    warn(`Предупреждение: ${entry.job} #${entry.build} пропущен (${reason}).`);
    const legacyChanged = markLegacy(entry);
    skip(result, reason);
    return legacyChanged;
  }

  try {
    const cases = readMainRecords(report);
    let changed = false;
    if (cases.length === 0) {
      if (entry.testsRan) {
        entry.testsRan = false;
        result.updated += 1;
        changed = true;
      }
      if (entry.fingerprints.length > 0) {
        entry.fingerprints = [];
        changed = true;
      }
      if (entry.signatureVersion !== undefined) {
        delete entry.signatureVersion;
        changed = true;
      }
      return changed;
    }
    const fingerprints = [...new Set(
      listFailures(cases, 'failed').map((failure) => failure.fingerprint)
    )];
    if (!sameStrings(entry.fingerprints, fingerprints)) {
      entry.fingerprints = fingerprints;
      result.updated += 1;
      changed = true;
    }
    if (entry.signatureVersion !== undefined) {
      delete entry.signatureVersion;
      changed = true;
    }
    return changed;
  } catch (error) {
    const reason = `ошибка чтения отчёта: ${error instanceof Error ? error.message : String(error)}`;
    warn(`Предупреждение: ${entry.job} #${entry.build} пропущен (${reason}).`);
    const legacyChanged = markLegacy(entry);
    skip(result, reason);
    return legacyChanged;
  }
}

function processEntry(
  cacheDir: string,
  entry: JournalEntry,
  resolveBuildUrl: ResolveBuildUrl,
  warn: (message: string) => void,
  result: RepairResult
): boolean {
  const meta = readCachedMeta(cacheDir, entry, warn, result);
  let changed = false;

  if (fillRunRefs(cacheDir, entry)) {
    result.enriched += 1;
    changed = true;
  }

  if (enrichEntry(entry, meta, resolveBuildUrl(entry.job, entry.build, entry.server))) {
    result.enriched += 1;
    changed = true;
  }

  if (updateFingerprints(cacheDir, entry, warn, result)) {
    changed = true;
  }

  return changed;
}

interface CachedMeta {
  timestamp?: number | null;
  durationMs?: number | null;
  commit?: string | null;
}

function enrichEntry(
  entry: JournalEntry,
  meta: CachedMeta | null,
  buildUrl: string | null
): boolean {
  let changed = false;
  if (entry.buildTimestamp === null && typeof meta?.timestamp === 'number') {
    entry.buildTimestamp = meta.timestamp;
    changed = true;
  }
  if (entry.durationMs === null && typeof meta?.durationMs === 'number') {
    entry.durationMs = meta.durationMs;
    changed = true;
  }
  if (entry.commit === null && typeof meta?.commit === 'string') {
    entry.commit = meta.commit;
    changed = true;
  }
  if (entry.buildUrl === null && buildUrl) {
    entry.buildUrl = buildUrl;
    changed = true;
  }
  return changed;
}

function collapseDuplicates(entries: JournalEntry[], result: RepairResult, resolveServer?: ResolveRunServer): JournalEntry[] {
  const positions = new Map<string, number>();
  const unique: JournalEntry[] = [];
  for (const entry of entries) {
    const key = runKey(entry, resolveServer);
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, unique.length);
      unique.push(entry);
      continue;
    }
    result.duplicatesRemoved += 1;
    if (Date.parse(entry.analyzedAt) > Date.parse(unique[position].analyzedAt)) {
      unique[position] = entry;
    }
  }
  return unique;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function markLegacy(entry: JournalEntry): boolean {
  if (entry.signatureVersion === 'legacy') {
    return false;
  }
  entry.signatureVersion = 'legacy';
  return true;
}

function skip(result: RepairResult, reason: string, count = 1): void {
  result.skipped += count;
  result.skippedReasons[reason] = (result.skippedReasons[reason] ?? 0) + count;
}
