import { resolveServer } from '../../src/serverResolution.js';
import { DEFAULT_ENVIRONMENT } from '../../src/configFields.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from '../../src/config.js';
import { DEFAULT_SETTINGS } from '../../src/settings.js';
import { reportDir, runDir } from '../../src/fetcher/cachePaths.js';
import { pruneRuns } from '../../src/fetcher/prune.js';
import { appendAnalysis } from '../../src/journal/appendAnalysis.js';
import { appendEntry, readEntries, type JournalEntry } from '../../src/journal/journal.js';
import { repairJournal } from '../../src/journal/repair.js';
import { ensureTestSet, fillRunRefs, readSourceHash, testSetFile } from '../../src/journal/runRefs.js';
import { mainRecords, readTestCases } from '../../src/report/read.js';

const fixtures = path.join(__dirname, '..', 'fixtures', 'run-30', 'test-cases');

let cacheDir: string;

function config(): Config {
  return {
    servers: {
      jenkins: {
        ...resolveServer('main', {}, undefined, {}),
        kind: 'jenkins',
        kindSource: 'file',
        baseUrl: '',
        baseUrlSource: 'default',
        reportArtifact: 'allure-report.zip',
        reportArtifactSource: 'default',
        workspaceNodeMax: 40,
        workspaceNodeMaxSource: 'default',
        proxyUser: '',
        proxyUserSet: false,
        proxyUserSource: 'default',
        proxyPass: '',
        proxyPassSet: false,
        proxyPassSource: 'default'
      }
    },
    cacheDir,
    defaultServer: 'jenkins',
    repos: [],
    environment: DEFAULT_ENVIRONMENT,
    allowedJobs: [],
    settings: { ...DEFAULT_SETTINGS },
    profileName: 'default',
    profileSource: 'default',
    description: '',
    profileFile: path.join(cacheDir, '..', 'profile.json'),
    profileFileFound: true,
    credentialsFile: path.join(cacheDir, '..', 'credentials.json')
  };
}

function placeReport(job: string, build: number): void {
  const target = path.join(reportDir(cacheDir, job, build), 'data', 'test-cases');
  mkdirSync(target, { recursive: true });
  cpSync(fixtures, target, { recursive: true });
  const widgets = path.join(reportDir(cacheDir, job, build), 'widgets');
  mkdirSync(widgets, { recursive: true });
  const total = mainRecords(readTestCases(reportDir(cacheDir, job, build))).length;
  writeFileSync(
    path.join(widgets, 'summary.json'),
    JSON.stringify({ statistic: { total } }),
    'utf8'
  );
}

function placeManifest(job: string, build: number, sha256: string | null): void {
  const dir = runDir(cacheDir, job, build);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ job, build, source: sha256 === null ? null : { sha256 } }),
    'utf8'
  );
}

beforeEach(() => {
  cacheDir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-run-refs-'));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('Сохранение состава тестов', () => {
  it('пишет канонический состав и возвращает его сумму', () => {
    placeReport('backend/smoke', 30);
    const hash = ensureTestSet(cacheDir, 'backend/smoke', 30);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const file = testSetFile(cacheDir, hash!);
    const pairs = JSON.parse(readFileSync(file, 'utf8')) as [string, string][];
    expect(pairs.length).toBeGreaterThan(0);
    const names = pairs.map(([name]) => name);
    expect([...names].sort()).toEqual(names);
    expect(pairs.every(([, status]) => typeof status === 'string' && status.length > 0)).toBe(true);
  });

  it('одинаковый состав из разных прогонов хранится одним файлом', () => {
    placeReport('backend/smoke', 30);
    placeReport('backend/smoke', 31);

    const first = ensureTestSet(cacheDir, 'backend/smoke', 30);
    const second = ensureTestSet(cacheDir, 'backend/smoke', 31);

    expect(second).toBe(first);
    expect(readdirSync(path.join(cacheDir, 'test-sets'))).toHaveLength(1);
  });

  it('возвращает null без отчёта', () => {
    expect(ensureTestSet(cacheDir, 'backend/smoke', 30)).toBeNull();
  });

  it('Расхождение состава Allure при записи разбора — ошибка', () => {
    const target = path.join(reportDir(cacheDir, 'backend/smoke', 31), 'data', 'test-cases');
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'one.json'), JSON.stringify({ fullName: 'a', status: 'passed' }), 'utf8');
    mkdirSync(path.join(reportDir(cacheDir, 'backend/smoke', 31), 'widgets'), { recursive: true });
    writeFileSync(
      path.join(reportDir(cacheDir, 'backend/smoke', 31), 'widgets', 'summary.json'),
      JSON.stringify({ statistic: { total: 3 } }),
      'utf8'
    );
    expect(() => ensureTestSet(cacheDir, 'backend/smoke', 31)).toThrow(/statistic\.total/);
  });
});

describe('Хэш исходников прогона', () => {
  it('берёт сумму архива из манифеста и null при её отсутствии', () => {
    placeManifest('backend/smoke', 30, 'a'.repeat(64));
    expect(readSourceHash(cacheDir, 'backend/smoke', 30)).toBe('a'.repeat(64));

    placeManifest('backend/smoke', 31, null);
    expect(readSourceHash(cacheDir, 'backend/smoke', 31)).toBeNull();
    expect(readSourceHash(cacheDir, 'backend/smoke', 99)).toBeNull();
  });
});

describe('файлы составов и очистка', () => {
  it('очистка прогонов сверх предела не трогает test-sets', () => {
    placeReport('backend/smoke', 30);
    const hash = ensureTestSet(cacheDir, 'backend/smoke', 30)!;
    for (const build of [31, 32, 33]) {
      mkdirSync(runDir(cacheDir, 'backend/smoke', build), { recursive: true });
    }

    pruneRuns(cacheDir, 'backend/smoke', 1);

    expect(existsSync(testSetFile(cacheDir, hash))).toBe(true);
  });
});

describe('запись разбора и починка', () => {
  const analysis = {
    job: 'backend/smoke',
    build: 30,
    env: 'stage',
    city: '',
    branch: '',
    codeBranch: '',
    result: 'FAILURE',
    testsRan: true,
    total: null,
    failed: null,
    recoveredAfterRetry: 0,
    verdict: 'проверка ссылок',
    fingerprints: ['известная причина'],
    model: '',
    analysisDurationMs: 0,
    tokensIn: 0,
    tokensOut: 0
  };

  it('appendAnalysis записывает суммы состава и архива', () => {
    placeReport('backend/smoke', 30);
    placeManifest('backend/smoke', 30, 'b'.repeat(64));

    appendAnalysis(config(), { ...analysis, fingerprints: [] });

    const entry = readEntries(cacheDir).entries[0];
    expect(entry.testSetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.sourceHash).toBe('b'.repeat(64));
  });

  it('appendAnalysis пишет null для прогона без кэша', () => {
    appendAnalysis(config(), {
      ...analysis,
      result: 'SUCCESS',
      total: null,
      failed: null,
      fingerprints: [],
      testsRan: true
    });

    const entry = readEntries(cacheDir).entries[0];
    expect(entry.testSetHash).toBeNull();
    expect(entry.sourceHash).toBeNull();
  });

  it('fillRunRefs дозаполняет только пустые ссылки', () => {
    placeReport('backend/smoke', 30);
    placeManifest('backend/smoke', 30, 'c'.repeat(64));
    const entry: JournalEntry = {
      ...analysis,
      analyzedAt: '2026-08-01T00:00:00.000Z',
      buildTimestamp: null,
      durationMs: null,
      commit: null,
      buildUrl: null
    };

    expect(fillRunRefs(cacheDir, entry)).toBe(true);
    expect(entry.sourceHash).toBe('c'.repeat(64));
    expect(entry.testSetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fillRunRefs(cacheDir, entry)).toBe(false);
  });

  it('repair дозаполняет ссылки у старой записи', () => {
    placeReport('backend/smoke', 30);
    placeManifest('backend/smoke', 30, 'd'.repeat(64));
    appendEntry(cacheDir, { ...analysis, analyzedAt: '2026-08-01T00:00:00.000Z' });
    expect(readEntries(cacheDir).entries[0].testSetHash).toBeNull();

    const result = repairJournal(cacheDir, () => '', () => {});

    expect(result.enriched).toBeGreaterThan(0);
    const entry = readEntries(cacheDir).entries[0];
    expect(entry.sourceHash).toBe('d'.repeat(64));
    expect(entry.testSetHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
