import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { JournalEntry } from '../../src/journal/journal.js';

export const generatedAt = new Date('2026-08-07T00:00:00.000Z');
export const exactSignature = '  Element <button> missing\nSecond LINE & detail  ';

export function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    job: 'backend/smoke',
    build: 1,
    analyzedAt: '2026-08-01T00:00:00.000Z',
    env: 'stage',
    city: 'spb <x>',
    branch: 'main',
    codeBranch: 'main',
    result: 'FAILURE',
    testsRan: true,
    total: 10,
    failed: 2,
    recoveredAfterRetry: 1,
    verdict: 'Вердикт <опасный> & доказательство',
    fingerprints: [exactSignature],
    model: 'test',
    analysisDurationMs: 100,
    buildTimestamp: Date.parse('2026-08-01T00:00:00.000Z'),
    durationMs: 1000,
    commit: 'abc123',
    buildUrl: 'https://ci.example/job/backend/smoke',
    tokensIn: 0,
    tokensOut: 0,
    ...overrides
  };
}

export function makeCache(entries: JournalEntry[], broken = false): string {
  const cacheDir = mkdtempSync(path.join(os.tmpdir(), 'qa-report-'));
  writeFileSync(
    path.join(cacheDir, 'journal.jsonl'),
    entries.map((item) => JSON.stringify(item)).join('\n') + (broken ? '\n{broken\n' : '\n'),
    'utf8'
  );
  return cacheDir;
}

export function generationDir(outputDir: string): string {
  const current = readFileSync(path.join(outputDir, 'current.js'), 'utf8');
  const match = current.match(/"gens\/(.+)\/index\.html"/);
  if (!match) throw new Error(`Некорректный current.js: ${current}`);
  return path.join(outputDir, 'gens', match[1]);
}

export function readData<T>(file: string): T {
  const source = readFileSync(file, 'utf8');
  const match = source.match(/^window\.[A-Z_]+ = ([\s\S]*);\n$/);
  if (!match) throw new Error(`Некорректный файл данных: ${file}`);
  return JSON.parse(match[1]) as T;
}
