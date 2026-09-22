import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendEntry, readEntries, type JournalEntry, type JournalEntryInput, normalizeEntry } from '../../src/journal/journal.js';
import { repairJournal } from '../../src/journal/repair.js';
import { reportDir, runDir } from '../../src/fetcher/cachePaths.js';

let cacheDir: string;
const exactSignature = '  Token AbC-123\nSecond LINE  ';

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    job: 'backend/all-tests',
    build: 30,
    analyzedAt: '2026-08-06T03:12:00.000Z',
    env: 'stage',
    city: 'spb',
    branch: '',
    codeBranch: 'main',
    result: 'FAILURE',
    testsRan: true,
    total: 1,
    failed: 1,
    recoveredAfterRetry: 0,
    verdict: 'проверка',
    fingerprints: ['старый отпечаток'],
    model: 'test',
    analysisDurationMs: 1,
    buildTimestamp: null,
    durationMs: null,
    commit: null,
    buildUrl: null,
    tokensIn: 0,
    tokensOut: 0,
    ...overrides
  };
}

beforeEach(() => {
  cacheDir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-repair-'));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('Починка журнала', () => {
  it('сохраняет нечитаемую строку журнала', () => {
    const file = path.join(cacheDir, 'journal.jsonl');
    appendEntry(cacheDir, entry({ testsRan: false }));
    writeFileSync(file, `не JSON\n${readFileSync(file, 'utf8')}`, 'utf8');

    repairJournal(cacheDir, () => '', () => undefined);

    expect(readFileSync(file, 'utf8')).toContain('не JSON');
  });

  it('оставляет нечитаемую строку на её месте', () => {
    const file = path.join(cacheDir, 'journal.jsonl');
    appendEntry(cacheDir, entry({ build: 30, testsRan: false }));
    appendEntry(cacheDir, entry({ build: 31, testsRan: false }));
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    writeFileSync(file, `${lines[0]}\nне JSON\n${lines[1]}\n`, 'utf8');

    repairJournal(cacheDir, () => '', () => undefined);

    expect(readFileSync(file, 'utf8').split('\n')[1]).toBe('не JSON');
  });

  it('не оставляет временных файлов после починки', () => {
    appendEntry(cacheDir, entry({ testsRan: false }));

    repairJournal(cacheDir, () => '', () => undefined);

    expect(readdirSync(cacheDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('заменяет подписи точными уникальными текстами, а запись без кэша помечает legacy', () => {
    appendEntry(cacheDir, entry());
    appendEntry(cacheDir, entry({ build: 31, testsRan: false, fingerprints: ['не менять'] }));

    const report = reportDir(cacheDir, 'backend/all-tests', 30);
    mkdirSync(path.join(report, 'data', 'test-cases'), { recursive: true });
    const failed = JSON.parse(
      readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'run-30', 'test-cases', 'failed-main.json'), 'utf8')
    ) as Record<string, unknown>;
    failed.statusMessage = 'корневой текст';
    failed.testStage = {
      ...(failed.testStage as Record<string, unknown>),
      statusMessage: exactSignature,
      statusTrace: 'TRACE, который не входит в подпись'
    };
    writeFileSync(path.join(report, 'data', 'test-cases', 'failed.json'), JSON.stringify(failed), 'utf8');
    writeFileSync(
      path.join(report, 'data', 'test-cases', 'failed-duplicate.json'),
      JSON.stringify({ ...failed, uid: 'duplicate', name: 'duplicate', fullName: 'duplicate' }),
      'utf8'
    );
    mkdirSync(path.join(report, 'widgets'), { recursive: true });
    writeFileSync(
      path.join(report, 'widgets', 'summary.json'),
      JSON.stringify({ statistic: { total: 2, failed: 2, broken: 0, skipped: 0, passed: 0, unknown: 0 } }),
      'utf8'
    );
    mkdirSync(runDir(cacheDir, 'backend/all-tests', 30), { recursive: true });
    writeFileSync(path.join(runDir(cacheDir, 'backend/all-tests', 30), 'meta.json'), '{}', 'utf8');

    const result = repairJournal(cacheDir);
    const entries = readEntries(cacheDir).entries;

    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(1);
    expect(entries[0].fingerprints).toEqual([exactSignature]);
    expect(entries[0]).not.toHaveProperty('signatureVersion');
    expect(entries[1].fingerprints).toEqual(['не менять']);
    expect(entries[1].signatureVersion).toBe('legacy');
    const backups = readdirSync(cacheDir).filter((name) => name.startsWith('journal.jsonl.bak-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(cacheDir, backups[0]), 'utf8')).toContain('старый отпечаток');
  });

  it('Починка не ставит testsRan false без нулевой сводки Allure', () => {
    appendEntry(cacheDir, entry({ build: 33, testsRan: true, fingerprints: ['останется'] }));
    const report = reportDir(cacheDir, 'backend/all-tests', 33);
    mkdirSync(path.join(report, 'widgets'), { recursive: true });
    writeFileSync(
      path.join(report, 'widgets', 'summary.json'),
      JSON.stringify({ statistic: { total: 3, failed: 0, broken: 0, skipped: 0, passed: 3, unknown: 0 } }),
      'utf8'
    );
    mkdirSync(runDir(cacheDir, 'backend/all-tests', 33), { recursive: true });
    writeFileSync(path.join(runDir(cacheDir, 'backend/all-tests', 33), 'meta.json'), '{}', 'utf8');

    const warnings: string[] = [];
    const result = repairJournal(cacheDir, () => '', (message) => warnings.push(message));
    const entries = readEntries(cacheDir).entries;

    expect(entries[0].testsRan).toBe(true);
    expect(entries[0].fingerprints).toEqual(['останется']);
    expect(result.updated).toBe(0);
    expect(warnings.some((line) => /ошибка чтения отчёта/.test(line))).toBe(true);
  });

  it('Починка подтверждает пустой отчёт по сводке Allure', () => {
    appendEntry(cacheDir, entry({ build: 32, testsRan: true, fingerprints: ['устаревший'] }));
    const report = reportDir(cacheDir, 'backend/all-tests', 32);
    mkdirSync(path.join(report, 'widgets'), { recursive: true });
    writeFileSync(
      path.join(report, 'widgets', 'summary.json'),
      JSON.stringify({ statistic: { total: 0, failed: 0, broken: 0, skipped: 0, passed: 0, unknown: 0 } }),
      'utf8'
    );
    mkdirSync(runDir(cacheDir, 'backend/all-tests', 32), { recursive: true });
    writeFileSync(path.join(runDir(cacheDir, 'backend/all-tests', 32), 'meta.json'), '{}', 'utf8');

    const result = repairJournal(cacheDir, () => null, () => undefined);
    const entries = readEntries(cacheDir).entries;

    expect(result.updated).toBe(1);
    expect(entries[0].testsRan).toBe(false);
    expect(entries[0].fingerprints).toEqual([]);
  });

  it('обогащает поля из meta.json и схлопывает дубли по максимальному analyzedAt', () => {
    const older = entry({
      analyzedAt: '2026-08-06T03:12:00.000Z',
      buildTimestamp: null,
      durationMs: null,
      commit: null,
      buildUrl: null
    });
    const newer = entry({
      analyzedAt: '2026-08-07T03:12:00.000Z',
      fingerprints: ['неактуальный отпечаток'],
      buildTimestamp: null,
      durationMs: null,
      commit: null,
      buildUrl: null
    });
    writeFileSync(
      path.join(cacheDir, 'journal.jsonl'),
      `${JSON.stringify(older)}\n${JSON.stringify(newer)}\n`,
      'utf8'
    );

    const report = reportDir(cacheDir, 'backend/all-tests', 30);
    mkdirSync(path.join(report, 'data', 'test-cases'), { recursive: true });
    mkdirSync(path.join(report, 'widgets'), { recursive: true });
    writeFileSync(
      path.join(report, 'data', 'test-cases', 'failed.json'),
      readFileSync(path.join(process.cwd(), 'tests', 'fixtures', 'run-30', 'test-cases', 'failed-main.json')),
      'utf8'
    );
    writeFileSync(
      path.join(report, 'widgets', 'summary.json'),
      JSON.stringify({ statistic: { total: 1, failed: 1, broken: 0, skipped: 0, passed: 0, unknown: 0 } }),
      'utf8'
    );
    mkdirSync(runDir(cacheDir, 'backend/all-tests', 30), { recursive: true });
    writeFileSync(
      path.join(runDir(cacheDir, 'backend/all-tests', 30), 'meta.json'),
      JSON.stringify({ timestamp: 1785939886355, durationMs: 37153, commit: 'abc123' }),
      'utf8'
    );

    const result = repairJournal(
      cacheDir,
      (_job, build) => `https://jenkins.example/job/backend/job/all-tests/${build}`
    );
    const repaired = readEntries(cacheDir).entries;

    expect(result.updated).toBe(1);
    expect(result.enriched).toBe(2);
    expect(readEntries(cacheDir).entries[0].testSetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.duplicatesRemoved).toBe(1);
    expect(repaired).toHaveLength(1);
    expect(repaired[0]).toMatchObject({
      analyzedAt: newer.analyzedAt,
      buildTimestamp: 1785939886355,
      durationMs: 37153,
      commit: 'abc123',
      buildUrl: 'https://jenkins.example/job/backend/job/all-tests/30'
    });
    expect(readdirSync(cacheDir).filter((name) => name.startsWith('journal.jsonl.bak-'))).toHaveLength(1);
  });

  it('не переименовывает jenkinsUrl в старой строке', () => {
    const raw = {
      ...entry({ testsRan: false, fingerprints: [] }),
      jenkinsUrl: 'https://ci.example/old'
    } as Record<string, unknown>;
    delete raw.buildUrl;
    writeFileSync(path.join(cacheDir, 'journal.jsonl'), `${JSON.stringify(raw)}\n`, 'utf8');

    repairJournal(cacheDir, () => null, () => undefined);

    const parsed = JSON.parse(readFileSync(path.join(cacheDir, 'journal.jsonl'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(parsed.jenkinsUrl).toBe('https://ci.example/old');
    expect(parsed).not.toHaveProperty('buildUrl');
    expect(readEntries(cacheDir).entries[0].buildUrl).toBe('https://ci.example/old');
  });
});


describe('Разрешение сервера при починке', () => {
  function journalEntry(overrides: Partial<JournalEntryInput> = {}): JournalEntryInput {
    return {
      job: 'backend/all-tests',
      build: 30,
      analyzedAt: '2026-08-06T03:12:00.000Z',
      env: 'stage',
      city: 'spb',
      branch: '',
      codeBranch: 'main',
      result: 'FAILURE',
      testsRan: true,
      total: 1,
      failed: 1,
      recoveredAfterRetry: 0,
      verdict: 'проверка',
      fingerprints: [],
      model: 'test',
      analysisDurationMs: 1,
      buildTimestamp: null,
      durationMs: null,
      commit: null,
      buildUrl: null,
      tokensIn: 0,
      tokensOut: 0,
      ...overrides
    };
  }

  it('Починка разрешает сервер как остальные команды и не падает на джобе без сервера', () => {
      const cacheDir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-rf-repair-'));
      try {
        appendEntry(cacheDir, journalEntry({ job: 'Playwright/e2e', testsRan: false }));
        appendEntry(cacheDir, journalEntry({ job: 'Other/Job', build: 31, testsRan: false }));
        const result = repairJournal(
          cacheDir,
          (job, build) =>
            job.startsWith('Playwright') ? `https://jenkins.example/job/Playwright/job/e2e/${build}` : null,
          () => undefined
        );
        expect(result.skipped).toBeGreaterThan(0);
        expect(readEntries(cacheDir).entries).toHaveLength(2);
      } finally {
        rmSync(cacheDir, { recursive: true, force: true });
      }
    });
});


describe('Сохранность строк и резервных копий', () => {
  const job = 'folder/example-job';

  let cache: string;

  beforeEach(() => { cache = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-cache-')); });
  afterEach(() => { vi.restoreAllMocks(); rmSync(cache, { recursive: true, force: true }); });

  it('repair сохраняет JSON вне схемы на месте и не перезаписывает резервные копии', () => {
    const valid = normalizeEntry({ job, build: 7, analyzedAt: '2026-01-01', testsRan: false });
    const unknown = ' { "job": "folder/example-job", "build": 7, "future": true } ';
    const file = path.join(cache, 'journal.jsonl');
    writeFileSync(file, `${unknown}\n${JSON.stringify(valid)}\nnull\n`);
    const warn = vi.fn();
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-19T12:00:00Z'));
    repairJournal(cache, () => null, warn);
    const firstName = readdirSync(cache).find((name) => name.startsWith('journal.jsonl.bak-'))!;
    const firstBackup = readFileSync(path.join(cache, firstName), 'utf8');
    repairJournal(cache, () => 'https://ci.example/build/7', warn);
    expect(readFileSync(file, 'utf8').split('\n')[0]).toBe(unknown);
    expect(readFileSync(file, 'utf8').split('\n')[2]).toBe('null');
    expect(warn.mock.calls.flat().join(' ')).toContain('непонятные строки');
    expect(readdirSync(cache).filter((name) => name.startsWith('journal.jsonl.bak-'))).toHaveLength(2);
    expect(readFileSync(path.join(cache, firstName), 'utf8')).toBe(firstBackup);
  });
});
