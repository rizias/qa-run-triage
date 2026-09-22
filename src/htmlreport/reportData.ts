import { createHash } from 'node:crypto';
import { readEntries, type JournalEntry } from '../journal/journal.js';
import { toCacheKey } from '../fetcher/cachePaths.js';
import { DEFAULT_SETTINGS, REPORT_FORMAT } from '../settings.js';
import type { ResolveRunServer } from '../journal/identity.js';
import { runKey } from '../journal/identity.js';
import { normalizeJob } from '../access.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface EntryView {
  entry: JournalEntry;
  time: number;
  fallbackTime: boolean;
}

export interface SignatureReference {
  id: string;
  preview: string;
  legacy: boolean;
}

export interface ReportEntry extends Omit<JournalEntry, 'fingerprints'> {
  jobKey: string;
  time: number;
  fallbackTime: boolean;
  incomplete: boolean;
  signatures: SignatureReference[];
}

export interface PairSummary {
  server?: string;
  job: string;
  env: string;
  count: number;
  status: 'open' | 'gone';
}

export interface SignatureSeries {
  id: string;
  text: string;
  preview: string;
  occurrences: EntryView[];
  first: number;
  last: number;
  status: 'open' | 'gone';
  legacy: boolean;
  pairs: PairSummary[];
}

export interface ReportData {
  entries: EntryView[];
  reportEntries: ReportEntry[];
  signatures: SignatureSeries[];
  months: Map<string, ReportEntry[]>;
  skippedLines: number;
  incompleteEntries: number;
  generatedAt: Date;
  timeZone: string;
  windowDays: number;
  windowStart: number;
  yearStart: number;
}

export function buildData(cacheDir: string, generatedAt: Date, windowDays: number, resolveServer?: ResolveRunServer, timeZone = DEFAULT_SETTINGS.reportTimeZone): ReportData {
  const read = readReportEntries(cacheDir, resolveServer);
  const entries = read.entries.map(toEntryView).sort(compareRecent);
  const latestByPair = new Map<string, EntryView>();
  for (const view of entries) {
    if (!view.entry.testsRan || view.entry.env.length === 0) {
      continue;
    }
    if (!latestByPair.has(pairKey(view.entry))) {
      latestByPair.set(pairKey(view.entry), view);
    }
  }

  const occurrences = new Map<string, EntryView[]>();
  const signatureTexts = new Map<string, string>();
  for (const view of entries) {
    for (const text of new Set(view.entry.fingerprints)) {
      const id = signatureId(text);
      const knownText = signatureTexts.get(id);
      if (knownText !== undefined && knownText !== text) {
        throw new Error(
          `Коллизия ${REPORT_FORMAT.signatureIdLength}-символьной SHA-256 для подписей ${id}`
        );
      }
      signatureTexts.set(id, text);
      const values = occurrences.get(id) ?? [];
      values.push(view);
      occurrences.set(id, values);
    }
  }

  const signatures = [...signatureTexts.entries()].map(([id, text]) => {
    const signatureOccurrences = (occurrences.get(id) ?? []).sort(compareOldest);
    const pairOccurrences = new Map<string, EntryView[]>();
    for (const occurrence of signatureOccurrences) {
      const key = pairKey(occurrence.entry);
      const values = pairOccurrences.get(key) ?? [];
      values.push(occurrence);
      pairOccurrences.set(key, values);
    }
    const pairs = [...pairOccurrences.entries()].map(([key, values]) => {
      const latest = latestByPair.get(key);
      const { job, env, server } = values[0].entry;
      return {
        job,
        env,
        server,
        count: values.length,
        status:
          latest === undefined || latest.entry.fingerprints.includes(text)
            ? ('open' as const)
            : ('gone' as const)
      };
    }).sort((left, right) => left.job.localeCompare(right.job) || left.env.localeCompare(right.env));
    return {
      id,
      text,
      preview: preview(text, REPORT_FORMAT.signaturePreviewLength),
      occurrences: signatureOccurrences,
      first: signatureOccurrences[0]?.time ?? 0,
      last: signatureOccurrences[signatureOccurrences.length - 1]?.time ?? 0,
      status: pairs.some((pair) => pair.status === 'open') ? 'open' as const : 'gone' as const,
      legacy: signatureOccurrences.some((view) => view.entry.signatureVersion === 'legacy'),
      pairs
    };
  }).sort((left, right) => Number(right.status === 'open') - Number(left.status === 'open') || right.last - left.last || left.preview.localeCompare(right.preview));

  const references = new Map(signatures.map((series) => [series.text, {
    id: series.id,
    preview: series.preview,
    legacy: series.legacy
  }]));
  const reportEntries = entries.map((view) => toReportEntry(view, references));
  const months = new Map<string, ReportEntry[]>();
  for (const entry of reportEntries) {
    const month = monthKey(entry.time, timeZone);
    const values = months.get(month) ?? [];
    values.push(entry);
    months.set(month, values);
  }

  return {
    entries,
    reportEntries,
    signatures,
    months,
    skippedLines: read.brokenLines.length,
    incompleteEntries: reportEntries.filter((entry) => entry.incomplete).length,
    generatedAt,
    timeZone,
    windowDays,
    windowStart: generatedAt.getTime() - windowDays * DAY_MS,
    yearStart: generatedAt.getTime() - REPORT_FORMAT.historyDays * DAY_MS
  };
}

export function toEntryView(entry: JournalEntry): EntryView {
  const fallbackTime = typeof entry.buildTimestamp !== 'number';
  const parsed = fallbackTime ? Date.parse(entry.analyzedAt) : entry.buildTimestamp!;
  return { entry, time: Number.isNaN(parsed) ? 0 : parsed, fallbackTime };
}

function readReportEntries(cacheDir: string, resolveServer?: ResolveRunServer): ReturnType<typeof readEntries> {
  const read = readEntries(cacheDir);
  for (const entry of read.entries) {
    const server = entry.server ?? resolveServer?.(entry.job);
    if (server !== undefined) entry.server = server;
  }
  read.entries = [...new Map(read.entries.map((entry) => [runKey(entry, resolveServer), entry])).values()];
  return read;
}

export function toReportEntry(view: EntryView, references: Map<string, SignatureReference>): ReportEntry {
  const { fingerprints, ...entry } = view.entry;
  return {
    ...entry,
    jobKey: reportJobKey(entry),
    time: view.time,
    fallbackTime: view.fallbackTime,
    incomplete: entry.env.length === 0,
    signatures: [...new Set(fingerprints)].map((text) => ({
      ...references.get(text)!,
      legacy: entry.signatureVersion === 'legacy'
    }))
  };
}

export function toOccurrence(view: EntryView): Omit<ReportEntry, 'signatures'> {
  const { fingerprints: _fingerprints, ...entry } = view.entry;
  return {
    ...entry,
    jobKey: reportJobKey(entry),
    time: view.time,
    fallbackTime: view.fallbackTime,
    incomplete: entry.env.length === 0
  };
}

export function compareRecent(left: EntryView, right: EntryView): number {
  return right.time - left.time || right.entry.build - left.entry.build;
}

export function compareOldest(left: EntryView, right: EntryView): number {
  return left.time - right.time || left.entry.build - right.entry.build;
}

export function compareReportRecent(left: ReportEntry, right: ReportEntry): number {
  return right.time - left.time || right.build - left.build;
}

export function pairKey(entry: JournalEntry): string {
  return JSON.stringify([entry.server ?? '', normalizeJob(entry.job), entry.env]);
}

export function reportJobKey(entry: Pick<JournalEntry, 'job' | 'server'>): string {
  return entry.server === undefined ? toCacheKey(entry.job) : toCacheKey(JSON.stringify([entry.server, entry.job]));
}

export function signatureId(value: string): string {
  return createHash('sha256')
    .update(value, 'utf8')
    .digest('hex')
    .slice(0, REPORT_FORMAT.signatureIdLength);
}

export function preview(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit - 1);
  let boundary = -1;
  for (const match of cut.matchAll(/\s+/gu)) {
    boundary = match.index;
  }
  const text = cut.slice(0, boundary > 0 ? boundary : cut.length).trimEnd();
  return `${text}…`;
}

export function monthKey(time: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit'
  }).formatToParts(new Date(time));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year ?? '0000'}-${values.month ?? '00'}`;
}
