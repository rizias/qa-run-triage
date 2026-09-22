import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { reportDir, runDir } from '../fetcher/cachePaths.js';
import { atomicWriteFile } from '../lock.js';
import { mainRecords, readAllureSummary, readTestCases } from '../report/read.js';
import type { JournalEntry } from './journal.js';

export function testSetFile(cacheDir: string, hash: string): string {
  return path.join(cacheDir, 'test-sets', `${hash}.json`);
}

export function writeTestSet(cacheDir: string, reportPath: string): string | null {
  if (!existsSync(path.join(reportPath, 'data', 'test-cases'))) {
    return null;
  }
  if (!existsSync(path.join(reportPath, 'widgets', 'summary.json'))) {
    return null;
  }
  const pairs = mainRecords(readTestCases(reportPath), readAllureSummary(reportPath).statistic.total)
    .map((testCase) => [testCase.fullName || testCase.name, testCase.status] as [string, string])
    .sort(comparePairs);
  const bytes = JSON.stringify(pairs);
  const hash = createHash('sha256').update(bytes, 'utf8').digest('hex');
  const file = testSetFile(cacheDir, hash);
  if (!existsSync(file)) {
    atomicWriteFile(file, bytes);
  }
  return hash;
}

export function ensureTestSet(cacheDir: string, job: string, build: number): string | null {
  return writeTestSet(cacheDir, reportDir(cacheDir, job, build));
}

export function readSourceHash(cacheDir: string, job: string, build: number): string | null {
  const file = path.join(runDir(cacheDir, job, build), 'manifest.json');
  if (!existsSync(file)) {
    return null;
  }
  try {
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as {
      source?: { sha256?: string } | null;
    };
    return manifest.source?.sha256 ?? null;
  } catch {
    return null;
  }
}

export function fillRunRefs(cacheDir: string, entry: JournalEntry): boolean {
  let filled = false;
  if ((entry.sourceHash ?? null) === null) {
    const sourceHash = readSourceHash(cacheDir, entry.job, entry.build);
    if (sourceHash !== null) {
      entry.sourceHash = sourceHash;
      filled = true;
    }
  }
  if ((entry.testSetHash ?? null) === null) {
    const testSetHash = ensureTestSet(cacheDir, entry.job, entry.build);
    if (testSetHash !== null) {
      entry.testSetHash = testSetHash;
      filled = true;
    }
  }
  return filled;
}

function comparePairs(left: [string, string], right: [string, string]): number {
  if (left[0] !== right[0]) {
    return left[0] < right[0] ? -1 : 1;
  }
  if (left[1] !== right[1]) {
    return left[1] < right[1] ? -1 : 1;
  }
  return 0;
}
