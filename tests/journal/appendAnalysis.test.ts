import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Config } from '../../src/config.js';
import { DEFAULT_ENVIRONMENT } from '../../src/configFields.js';
import { DEFAULT_SETTINGS } from '../../src/settings.js';
import { reportDir, runDir } from '../../src/fetcher/cachePaths.js';
import { readEntries } from '../../src/journal/journal.js';
import { appendAnalysis, parseAnalysis } from '../../src/journal/appendAnalysis.js';

let cacheDir: string;

const config = (allowedJobs: string[] = [], overrides: Partial<Config> = {}): Config => ({
  servers: {},
  cacheDir,
  repos: [],
  environment: DEFAULT_ENVIRONMENT,
  allowedJobs,
  settings: { ...DEFAULT_SETTINGS },
  profileName: 'default',
  profileSource: 'default',
  description: '',
  profileFile: path.join(cacheDir, 'profile.json'),
  profileFileFound: true,
  credentialsFile: path.join(cacheDir, 'credentials.json'),
  ...overrides
});

const green = {
  job: 'backend/smoke',
  build: 7,
  result: 'SUCCESS',
  testsRan: true,
  total: null,
  failed: null,
  recoveredAfterRetry: 0,
  verdict: 'прогон зелёный',
  fingerprints: []
};

beforeEach(() => {
  cacheDir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-append-'));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('Разбор входного объекта', () => {
  it('разбирает объект JSON и подставляет умолчания', () => {
    const parsed = parseAnalysis(JSON.stringify(green));
    expect(parsed).toMatchObject({ job: 'backend/smoke', build: 7, env: '', model: '' });
  });

  it('называет поле, которого не хватает', () => {
    const { verdict: _verdict, ...withoutVerdict } = green;
    expect(() => parseAnalysis(JSON.stringify(withoutVerdict))).toThrow(/verdict/);
  });

  it('сообщает о неразбираемом JSON', () => {
    expect(() => parseAnalysis('не JSON')).toThrow(/JSON/);
  });
});

describe('Добавление разбора', () => {
  it('записывает разбор в журнал', () => {
    appendAnalysis(config(), parseAnalysis(JSON.stringify(green)));
    expect(readEntries(cacheDir).entries).toMatchObject([{ job: 'backend/smoke', build: 7 }]);
  });

  it('отказывает в джобе вне списка', () => {
    expect(() =>
      appendAnalysis(config(['backend/other']), parseAnalysis(JSON.stringify(green)))
    ).toThrow(/allowedJobs/);
  });

  it('дозаполняет окружение из параметров билда по настройке environment', () => {
    const metaDir = runDir(cacheDir, green.job, green.build);
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(
      path.join(metaDir, 'meta.json'),
      JSON.stringify({ parameters: { STAND: 'stage-2', city: 'spb' } }),
      'utf8'
    );

    appendAnalysis(
      config([], { environment: { env: ['env', 'STAND'], city: ['city'] } }),
      parseAnalysis(JSON.stringify(green))
    );

    expect(readEntries(cacheDir).entries[0]).toMatchObject({ env: 'stage-2', city: 'spb' });
  });

  it('переводит testsRan в false, когда отчёт скачан, но записей ноль', () => {
    const widgets = path.join(reportDir(cacheDir, green.job, green.build), 'widgets');
    mkdirSync(widgets, { recursive: true });
    writeFileSync(
      path.join(widgets, 'summary.json'),
      JSON.stringify({ statistic: { failed: 0, broken: 0, skipped: 0, passed: 0, unknown: 0, total: 0 } }),
      'utf8'
    );

    appendAnalysis(config(), parseAnalysis(JSON.stringify({ ...green, testsRan: true, fingerprints: ['что-то'] })));

    expect(readEntries(cacheDir).entries[0]).toMatchObject({ testsRan: false, fingerprints: [] });
  });
});


describe('Строгая схема разбора', () => {
  const green = { job: 'backend/smoke', build: 7, testsRan: true, recoveredAfterRetry: 0, verdict: 'ок' };

  it('Номер билда строкой или неположительный — ошибка', () => {
      expect(() => parseAnalysis(JSON.stringify({ ...green, build: '7' }))).toThrow(/build/);
      expect(() => parseAnalysis(JSON.stringify({ ...green, build: 0 }))).toThrow(/build/);
      expect(() => parseAnalysis(JSON.stringify({ ...green, build: -1 }))).toThrow(/build/);
    });

  it('Лишнее поле во входе — ошибка', () => {
      expect(() => parseAnalysis(JSON.stringify({ ...green, extra: true }))).toThrow(/extra/);
    });
});
