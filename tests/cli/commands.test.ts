import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from '../../src/config.js';
import { DEFAULT_ENVIRONMENT } from '../../src/configFields.js';
import { DEFAULT_SETTINGS } from '../../src/settings.js';
import { reportDir, runDir } from '../../src/fetcher/cachePaths.js';
import { COMMAND_HANDLERS } from '../../src/cli/commands.js';

let cacheDir: string;

function config(): Config {
  return {
    servers: {},
    cacheDir,
    repos: [],
    environment: DEFAULT_ENVIRONMENT,
    allowedJobs: [],
    settings: { ...DEFAULT_SETTINGS },
    profileName: 'default',
    profileSource: 'default',
    description: '',
    profileFile: path.join(cacheDir, 'profile.json'),
    profileFileFound: true,
    credentialsFile: path.join(cacheDir, 'credentials.json')
  };
}

function writeMeta(job: string, build: number): void {
  const dir = runDir(cacheDir, job, build);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'meta.json'),
    JSON.stringify({ number: build, result: 'FAILURE', timestamp: 0, durationMs: 1, artifacts: [], parameters: {}, commit: null }),
    'utf8'
  );
}

function writeManifest(job: string, build: number, files: { name: string; bytes: number }[]): void {
  const dir = runDir(cacheDir, job, build);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ job, build, fetchedAt: '2026-09-18T00:00:00.000Z', files, missing: [], source: null, testSet: null }),
    'utf8'
  );
}

function writeEmptyReport(job: string, build: number): void {
  const widgets = path.join(reportDir(cacheDir, job, build), 'widgets');
  mkdirSync(widgets, { recursive: true });
  writeFileSync(
    path.join(widgets, 'summary.json'),
    JSON.stringify({
      reportName: 'AllureReport',
      testRuns: [],
      statistic: { failed: 0, broken: 0, skipped: 0, passed: 0, unknown: 0, total: 0 },
      time: {}
    }),
    'utf8'
  );
}

function captureLog(): { output: () => unknown } {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  return {
    output: () => JSON.parse(spy.mock.calls[spy.mock.calls.length - 1][0] as string) as unknown
  };
}

beforeEach(() => {
  cacheDir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-commands-'));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('summary с пустым отчётом', () => {
  it('отвечает testsRan: false и reportEmpty: true вместо ошибки', async () => {
    const job = 'Synthetic/EmptyReport';
    const build = 101;
    writeMeta(job, build);
    writeManifest(job, build, [{ name: 'report/', bytes: 10 }]);
    writeEmptyReport(job, build);

    const log = captureLog();
    await COMMAND_HANDLERS.summary(config(), { kind: 'summary', job, build });

    const summary = log.output() as { testsRan: boolean; reportEmpty: boolean; total: number };
    expect(summary.testsRan).toBe(false);
    expect(summary.reportEmpty).toBe(true);
    expect(summary.total).toBe(0);
  });
});

describe('failures с пустым отчётом', () => {
  it('отвечает пустым списком без --recovered', () => {
    const job = 'Synthetic/EmptyReport';
    const build = 102;
    writeMeta(job, build);
    writeManifest(job, build, [{ name: 'report/', bytes: 10 }]);
    writeEmptyReport(job, build);

    const log = captureLog();
    void COMMAND_HANDLERS.failures(config(), { kind: 'failures', job, build, include: 'failed' });

    expect(log.output()).toEqual([]);
  });

  it('отвечает пустым списком с --recovered', () => {
    const job = 'Synthetic/EmptyReport';
    const build = 103;
    writeMeta(job, build);
    writeManifest(job, build, [{ name: 'report/', bytes: 10 }]);
    writeEmptyReport(job, build);

    const log = captureLog();
    void COMMAND_HANDLERS.failures(config(), { kind: 'failures', job, build, include: 'recovered' });

    expect(log.output()).toEqual([]);
  });
});

describe('прогон никогда не скачивался', () => {
  it('summary завершается ошибкой про fetch', () => {
    expect(() =>
      void COMMAND_HANDLERS.summary(config(), { kind: 'summary', job: 'Synthetic/Missing', build: 1 })
    ).toThrow(/не скачан.*fetch/);
  });
});

describe('рассинхронизация кэша: манифест называет отчёт, каталога нет', () => {
  it('summary завершается ошибкой про повторное скачивание', () => {
    const job = 'Synthetic/Inconsistent';
    const build = 104;
    writeMeta(job, build);
    writeManifest(job, build, [{ name: 'report/', bytes: 10 }]);

    expect(() =>
      void COMMAND_HANDLERS.summary(config(), { kind: 'summary', job, build })
    ).toThrow(/нет записей тестов.*Скачайте прогон заново/);
  });
});

describe('битый JSON прогона', () => {
  it('Битый JSON манифеста и meta называет путь файла', () => {
    const job = 'folder/example-job';
    const build = 105;
    const dir = runDir(cacheDir, job, build);
    mkdirSync(dir, { recursive: true });
    const metaFile = path.join(dir, 'meta.json');
    writeFileSync(metaFile, '{не json', 'utf8');
    try {
      void COMMAND_HANDLERS.summary(config(), { kind: 'summary', job, build });
      throw new Error('ожидалась ошибка JSON');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(metaFile);
    }
  });
});
