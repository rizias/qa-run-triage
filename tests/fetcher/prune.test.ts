import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pruneRunsWithoutLegacySourceDeletion } from '../../src/fetcher/fetchRunSteps.js';
import { pruneRuns } from '../../src/fetcher/prune.js';
import { toCacheKey } from '../../src/fetcher/cachePaths.js';

let cache: string;

beforeEach(() => {
  cache = mkdtempSync(path.join(tmpdir(), 'triage-'));
  for (const build of [10, 11, 12, 13]) {
    mkdirSync(path.join(cache, 'runs', toCacheKey('backend/all-tests'), String(build)), {
      recursive: true
    });
  }
});

afterEach(() => {
  rmSync(cache, { recursive: true, force: true });
});

describe('Очистка кэша прогонов', () => {
  it('оставляет заданное число самых новых прогонов', () => {
    pruneRuns(cache, 'backend/all-tests', 2);
    expect(existsSync(path.join(cache, 'runs', toCacheKey('backend/all-tests'), '13'))).toBe(true);
    expect(existsSync(path.join(cache, 'runs', toCacheKey('backend/all-tests'), '12'))).toBe(true);
  });

  it('удаляет прогоны сверх лимита', () => {
    pruneRuns(cache, 'backend/all-tests', 2);
    expect(existsSync(path.join(cache, 'runs', toCacheKey('backend/all-tests'), '11'))).toBe(false);
    expect(existsSync(path.join(cache, 'runs', toCacheKey('backend/all-tests'), '10'))).toBe(false);
  });

  it('возвращает список удалённых номеров', () => {
    const removed = pruneRuns(cache, 'backend/all-tests', 3);
    expect(removed).toEqual(['10']);
  });

  it('ничего не делает, когда прогонов меньше лимита', () => {
    const removed = pruneRuns(cache, 'backend/all-tests', 10);
    expect(removed).toEqual([]);
  });

  it('старый скачанный прогон также подчиняется пределу', () => {
    const removed = pruneRuns(cache, 'backend/all-tests', 2);
    expect(removed).toEqual(['11', '10']);
    expect(existsSync(path.join(cache, 'runs', toCacheKey('backend/all-tests'), '10'))).toBe(false);
  });
});

describe('pruneRuns — числовая сортировка', () => {
  it('сравнивает номера как числа, а не как строки', () => {
    const sortCache = mkdtempSync(path.join(tmpdir(), 'triage-sort-'));
    for (const build of [9, 10]) {
      mkdirSync(path.join(sortCache, 'runs', toCacheKey('backend/all-tests'), String(build)), {
        recursive: true
      });
    }
    try {
      pruneRuns(sortCache, 'backend/all-tests', 1);
      expect(existsSync(path.join(sortCache, 'runs', toCacheKey('backend/all-tests'), '10'))).toBe(
        true
      );
      expect(existsSync(path.join(sortCache, 'runs', toCacheKey('backend/all-tests'), '9'))).toBe(
        false
      );
    } finally {
      rmSync(sortCache, { recursive: true, force: true });
    }
  });
});

describe('pruneRuns — отсутствующий каталог', () => {
  it('возвращает пустой список, когда каталога джобы ещё нет', () => {
    const emptyCache = mkdtempSync(path.join(tmpdir(), 'triage-empty-'));
    try {
      const removed = pruneRuns(emptyCache, 'backend/all-tests', 2);
      expect(removed).toEqual([]);
    } finally {
      rmSync(emptyCache, { recursive: true, force: true });
    }
  });
});

describe('pruneRuns — журнал и отчёт', () => {
  it('не трогает journal.jsonl и каталог отчёта при очистке сверх предела', () => {
    const journalFile = path.join(cache, 'journal.jsonl');
    writeFileSync(journalFile, '{"job":"backend/all-tests"}\n', 'utf8');
    const reportDir = path.join(cache, 'journal-report');
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(path.join(reportDir, 'index.html'), 'отчёт', 'utf8');

    const journalBefore = readFileSync(journalFile, 'utf8');
    const reportBefore = readFileSync(path.join(reportDir, 'index.html'), 'utf8');

    const removed = pruneRuns(cache, 'backend/all-tests', 2);

    expect(removed).toEqual(['11', '10']);
    expect(existsSync(journalFile)).toBe(true);
    expect(readFileSync(journalFile, 'utf8')).toBe(journalBefore);
    expect(existsSync(reportDir)).toBe(true);
    expect(readFileSync(path.join(reportDir, 'index.html'), 'utf8')).toBe(reportBefore);
  });
});

describe('pruneRuns — посторонние записи', () => {
  it('игнорирует нечисловые файлы и папки рядом с номерами прогонов', () => {
    const mixedCache = mkdtempSync(path.join(tmpdir(), 'triage-mixed-'));
    const jobDir = path.join(mixedCache, 'runs', toCacheKey('backend/all-tests'));
    mkdirSync(path.join(jobDir, '10'), { recursive: true });
    mkdirSync(path.join(jobDir, 'latest'), { recursive: true });
    writeFileSync(path.join(jobDir, 'notes.txt'), 'постороннее', 'utf8');
    try {
      const removed = pruneRuns(mixedCache, 'backend/all-tests', 1);
      expect(removed).toEqual([]);
      expect(existsSync(path.join(jobDir, '10'))).toBe(true);
      expect(existsSync(path.join(jobDir, 'latest'))).toBe(true);
      expect(existsSync(path.join(jobDir, 'notes.txt'))).toBe(true);
    } finally {
      rmSync(mixedCache, { recursive: true, force: true });
    }
  });

  it('удаляет осиротевший временный каталог', () => {
    const orphan = path.join(
      cache,
      'runs',
      toCacheKey('backend/all-tests'),
      '10.tmp-orphan'
    );
    mkdirSync(orphan, { recursive: true });

    pruneRuns(cache, 'backend/all-tests', 10);

    expect(existsSync(orphan)).toBe(false);
  });

  it('не удаляет временный каталог процесса, который ещё работает', () => {
    const active = path.join(
      cache,
      'runs',
      toCacheKey('backend/all-tests'),
      `10.tmp-${process.pid}-1`
    );
    mkdirSync(active, { recursive: true });

    pruneRuns(cache, 'backend/all-tests', 10);

    expect(existsSync(active)).toBe(true);
  });
});

describe('Очистка с сохранением прежних исходников', () => {
  it('Очистка кэша не поднимает keep из-за прогона со старой схемой', () => {
    const job = 'folder/example-job';
    const jobDir = path.join(cache, 'runs', toCacheKey(job));
    for (const build of [1, 2, 3, 4, 5]) {
      mkdirSync(path.join(jobDir, String(build)), { recursive: true });
    }
    mkdirSync(path.join(jobDir, '1', 'sources'), { recursive: true });
    writeFileSync(path.join(jobDir, '1', 'sources', 'old.java'), 'old', 'utf8');

    pruneRunsWithoutLegacySourceDeletion(cache, job, 2);

    expect(existsSync(path.join(jobDir, '1'))).toBe(true);
    expect(existsSync(path.join(jobDir, '2'))).toBe(false);
    expect(existsSync(path.join(jobDir, '3'))).toBe(false);
    expect(existsSync(path.join(jobDir, '4'))).toBe(true);
    expect(existsSync(path.join(jobDir, '5'))).toBe(true);
  });
});
