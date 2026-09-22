import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isJobAllowed, normalizeJob } from '../access.js';
import { LEGACY_BUILD_URL_FIELD } from '../ci/createClient.js';
import { atomicWriteFile, withFileLock } from '../lock.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import { validateJournalEntry } from './entryValidation.js';
import { runKey, sameRun, type ResolveRunServer } from './identity.js';

export interface JournalEntry {
  job: string;
  build: number;
  analyzedAt: string;
  env: string;
  city: string;
  branch: string;
  codeBranch: string;
  result: string | null;
  testsRan: boolean;
  total: number | null;
  failed: number | null;
  recoveredAfterRetry: number;
  verdict: string;
  fingerprints: string[];
  testSetHash?: string | null;
  sourceHash?: string | null;
  signatureVersion?: 'legacy';
  buildTimestamp: number | null;
  durationMs: number | null;
  commit: string | null;
  buildUrl: string | null;
  model: string;
  analysisDurationMs: number;
  tokensIn: number;
  tokensOut: number;
  server?: string;
}

export type JournalEntryInput = Omit<
  JournalEntry,
  'buildTimestamp' | 'durationMs' | 'commit' | 'buildUrl' | 'tokensIn' | 'tokensOut'
> & Partial<Pick<JournalEntry, 'buildTimestamp' | 'durationMs' | 'commit' | 'buildUrl' | 'tokensIn' | 'tokensOut'>>;

export interface JournalReadResult {
  entries: JournalEntry[];
  brokenLines: string[];
}

function journalFile(cacheDir: string): string {
  return path.join(cacheDir, 'journal.jsonl');
}

export interface JournalLockOptions {
  resolveServer?: ResolveRunServer;
  pollMs?: number;
  timeoutMs?: number;
}

export interface JournalLock {
  readonly held: true;
}

export function withJournalLock<T>(
  cacheDir: string,
  work: (lock: JournalLock) => T,
  options: JournalLockOptions = {}
): T {
  mkdirSync(cacheDir, { recursive: true });
  return withFileLock(`${journalFile(cacheDir)}.lock`, () => work({ held: true }), {
    timeoutMs: options.timeoutMs ?? DEFAULT_SETTINGS.journalLockTimeoutMs,
    pollMs: options.pollMs ?? DEFAULT_SETTINGS.journalLockPollMs
  });
}

export function appendEntry(
  cacheDir: string,
  entry: JournalEntryInput,
  lockOptions?: JournalLockOptions
): void {
  const normalized = normalizeEntry({ ...entry, job: normalizeJob(entry.job) });
  withJournalLock(cacheDir, (lock) => {
    const lines = readLines(cacheDir);
    const existingIndex = lines.findIndex((line) => isSameRun(line, normalized, lockOptions?.resolveServer ?? (() => normalized.server)));
    if (existingIndex === -1) {
      lines.push(serializeJournalEntry(normalized));
    } else {
      lines[existingIndex] = serializeJournalEntry(normalized);
    }
    writeJournalLines(cacheDir, lines, lock);
  }, lockOptions);
}

export function appendMissingEntries(
  cacheDir: string,
  entries: JournalEntryInput[],
  lockOptions?: JournalLockOptions
): number {
  return withJournalLock(
    cacheDir,
    (lock) => appendMissingUnderLock(cacheDir, entries, lock, lockOptions?.resolveServer),
    lockOptions
  );
}

function appendMissingUnderLock(
  cacheDir: string,
  entries: JournalEntryInput[],
  lock: JournalLock,
  resolveServer?: ResolveRunServer
): number {
  const existing = readEntries(cacheDir).entries;
  const known = new Set(existing.map((entry) => runKey(entry, resolveServer)));
  const missing: JournalEntry[] = [];

  for (const entry of entries) {
    const normalized = normalizeEntry({ ...entry, job: normalizeJob(entry.job) });
    const key = runKey(normalized, resolveServer);
    if (known.has(key)) {
      continue;
    }
    known.add(key);
    missing.push(normalized);
  }

  if (missing.length === 0) {
    return 0;
  }

  const lines = readLines(cacheDir);
  for (const entry of missing) {
    lines.push(serializeJournalEntry(entry));
  }
  writeJournalLines(cacheDir, lines, lock);
  return missing.length;
}

export function readEntries(cacheDir: string): JournalReadResult {
  const entries: JournalEntry[] = [];
  const brokenLines: string[] = [];
  for (const line of readLines(cacheDir)) {
    try {
      entries.push(normalizeEntry(JSON.parse(line)));
    } catch {
      brokenLines.push(line);
    }
  }
  return { entries, brokenLines };
}

export function writeJournalLines(cacheDir: string, lines: string[], lock: JournalLock): void {
  if (lock.held !== true) {
    throw new Error('Запись журнала возможна только под замком.');
  }
  atomicWriteFile(
    journalFile(cacheDir),
    lines.join('\n') + (lines.length > 0 ? '\n' : '')
  );
}

export function countFingerprint(
  cacheDir: string,
  value: string,
  sinceDays: number,
  allowedJobs?: readonly string[],
  resolveServer?: ResolveRunServer
): { count: number; builds: string[] } {
  const edge = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const matched = [...new Map(readEntries(cacheDir).entries.map((entry) => [runKey(entry, resolveServer), entry])).values()].filter(
    (entry) =>
      isJobAllowed(allowedJobs, entry.job) &&
      Date.parse(entry.analyzedAt) >= edge &&
      entry.fingerprints.includes(value)
  );
  return {
    count: matched.length,
    builds: matched.map((entry) => {
      const server = entry.server ?? resolveServer?.(entry.job);
      return `${server ? `${server}:` : ''}${normalizeJob(entry.job)}#${entry.build}`;
    })
  };
}

export function normalizeEntry(value: unknown): JournalEntry {
  const record = validateJournalEntry(value);
  const entry: JournalEntry = {
    ...record,
    job: record.job,
    build: record.build,
    analyzedAt: record.analyzedAt,
    env: stringOrDefault(record.env),
    city: stringOrDefault(record.city),
    branch: stringOrDefault(record.branch),
    codeBranch: stringOrDefault(record.codeBranch),
    result: stringOrNull(record.result),
    testsRan: record.testsRan,
    total: numberOrNull(record.total),
    failed: numberOrNull(record.failed),
    recoveredAfterRetry: numberOrDefault(record.recoveredAfterRetry),
    verdict: stringOrDefault(record.verdict),
    fingerprints: Array.isArray(record.fingerprints)
      ? record.fingerprints.filter((item): item is string => typeof item === 'string')
      : [],
    testSetHash: stringOrNull(record.testSetHash),
    sourceHash: stringOrNull(record.sourceHash),
    ...(record.signatureVersion === 'legacy' ? { signatureVersion: 'legacy' as const } : {}),
    buildTimestamp: numberOrNull(record.buildTimestamp),
    durationMs: numberOrNull(record.durationMs),
    commit: stringOrNull(record.commit),
    buildUrl: readBuildUrl(record),
    model: stringOrDefault(record.model),
    analysisDurationMs: numberOrDefault(record.analysisDurationMs),
    tokensIn: numberOrDefault(record.tokensIn),
    tokensOut: numberOrDefault(record.tokensOut),
    ...(typeof record.server === 'string' ? { server: record.server } : {})
  };
  if (LEGACY_BUILD_URL_FIELD in record && !('buildUrl' in record)) {
    return Object.assign(entry, { [LEGACY_BUILD_URL_FIELD]: entry.buildUrl });
  }
  return entry;
}

function readBuildUrl(record: Record<string, unknown>): string | null {
  if ('buildUrl' in record) {
    return stringOrNull(record.buildUrl);
  }
  if (LEGACY_BUILD_URL_FIELD in record) {
    return stringOrNull(record[LEGACY_BUILD_URL_FIELD]);
  }
  return null;
}

export function serializeJournalEntry(entry: JournalEntry): string {
  const record = { ...(entry as unknown as Record<string, unknown>) };
  if (Object.prototype.hasOwnProperty.call(record, LEGACY_BUILD_URL_FIELD)) {
    record[LEGACY_BUILD_URL_FIELD] = entry.buildUrl;
    delete record.buildUrl;
  }
  return JSON.stringify(record);
}

export function readJournalLines(cacheDir: string): string[] {
  return readLines(cacheDir);
}

function readLines(cacheDir: string): string[] {
  const file = journalFile(cacheDir);
  if (!existsSync(file)) {
    return [];
  }
  const lines = readFileSync(file, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function isSameRun(line: string, entry: JournalEntry, resolveServer?: ResolveRunServer): boolean {
  try {
    const parsed = normalizeEntry(JSON.parse(line));
    return sameRun(parsed, entry, resolveServer);
  } catch {
    return false;
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function numberOrDefault(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' || value === null ? value : null;
}

function stringOrDefault(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
