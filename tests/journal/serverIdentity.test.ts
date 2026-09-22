import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendEntry, appendMissingEntries, countFingerprint, readEntries } from '../../src/journal/journal.js';
import { fillMissingRunFields } from '../../src/journal/backfill.js';
import { repairJournal } from '../../src/journal/repair.js';
import { recordRuns } from '../../src/journal/recordRuns.js';
import { serverResolver } from '../../src/journal/identity.js';
import { loadConfig } from '../../src/config.js';
import { reportDir, runDir } from '../../src/fetcher/cachePaths.js';
import { writeJournalReport } from '../../src/htmlreport/report.js';
import { buildData } from '../../src/htmlreport/reportData.js';
import { entry, generatedAt, generationDir, makeCache, readData } from '../htmlreport/fixtures.js';
import type { BuildMeta, CiClient } from '../../src/ci/client.js';
import vm from 'node:vm';
import { connectionIdentity } from '../../src/fetcher/cacheServer.js';

describe('Идентичность прогона и сохранность журнала', () => {
  it('починка отвергает прежний адрес сервера и сохраняет исходную строку', () => {
    const row = entry({ server: 'main', testSetHash: null, sourceHash: null });
    const cache = makeCache([row]);
    const root = runDir(cache, row.job, row.build);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
      server: 'main', serverIdentity: connectionIdentity('main', 'https://old.example')
    }));
    const file = path.join(cache, 'journal.jsonl');
    const original = readFileSync(file, 'utf8');
    const result = repairJournal(cache, () => null, () => undefined, {
      resolveServer: () => 'main', baseUrl: () => 'https://new.example'
    });
    expect(result.skipped).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(original);
  });

  it('добавление, замена, дозапись и поиск различают серверы', () => {
    const cache = makeCache([]);
    const analyzedAt = new Date().toISOString();
    appendEntry(cache, entry({ server: 'first', analyzedAt }));
    appendEntry(cache, entry({ server: 'second', analyzedAt }));
    appendEntry(cache, entry({ server: 'first', analyzedAt, verdict: 'обновлено' }));
    expect(appendMissingEntries(cache, [entry({ server: 'second' }), entry({ server: 'third', analyzedAt })])).toBe(1);
    expect(readEntries(cache).entries.map((row) => [row.server, row.verdict])).toEqual([
      ['first', 'обновлено'], ['second', entry().verdict], ['third', entry().verdict]
    ]);
    expect(countFingerprint(cache, entry().fingerprints[0], 1).builds).toEqual([
      'first:backend/smoke#1', 'second:backend/smoke#1', 'third:backend/smoke#1'
    ]);
  });

  it('прежняя строка совпадает с текущим сервером и дозаполняется без потери полей', () => {
    const cache = makeCache([entry({ env: '', city: '', buildUrl: null })]);
    const file = path.join(cache, 'journal.jsonl');
    const before = readFileSync(file, 'utf8');
    const resolveServer = () => 'second';
    expect(appendMissingEntries(cache, [entry({ server: 'second' })], { resolveServer })).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(before);
    appendEntry(cache, entry({ server: 'first', env: 'первое' }), { resolveServer });
    fillMissingRunFields(cache, 'backend/smoke', 1,
      { server: 'second', env: 'второе', city: 'город', buildUrl: 'https://second.example/1' }, {});
    expect(readEntries(cache).entries.map((row) => [row.server, row.env])).toEqual([
      ['second', 'второе'], ['first', 'первое']
    ]);
  });

  it('починка не берёт метаданные, состав и ошибки с другого сервера', () => {
    const first = entry({ server: 'first', buildTimestamp: null, testSetHash: null, sourceHash: null });
    const cache = makeCache([first, entry({ server: 'second', testsRan: false })]);
    const root = runDir(cache, first.job, first.build);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ server: 'second', source: { sha256: 'a'.repeat(64) } }));
    writeFileSync(path.join(root, 'meta.json'), JSON.stringify({ timestamp: 999 }));
    const warn = vi.fn();
    const result = repairJournal(cache, () => null, warn);
    expect(result.duplicatesRemoved).toBe(0);
    expect(readEntries(cache).entries[0]).toMatchObject(first);
    expect(readEntries(cache).entries).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('другому серверу'));
  });

  it('починка удаляет только дубли одной тройки и хранит отдельные копии', () => {
    const cache = makeCache([
      entry({ server: 'first', testsRan: false }),
      entry({ server: 'second', testsRan: false }),
      entry({ server: 'first', testsRan: false, verdict: 'новее', analyzedAt: '2026-08-03T00:00:00Z' })
    ]);
    const result = repairJournal(cache, () => null, () => undefined);
    expect(result.duplicatesRemoved).toBe(1);
    expect(readEntries(cache).entries.map((row) => row.server)).toEqual(['first', 'second']);
    expect(readEntries(cache).entries[0].verdict).toBe('новее');
    expect(readdirSync(cache).filter((name) => name.startsWith('journal.jsonl.bak-'))).toHaveLength(1);
  });

  it.each([
    { verdict: { note: 'ценное' } }, { fingerprints: ['ошибка', 1] }, { server: 1 },
    { env: null }, { total: '1' }, { testSetHash: [] }, { tokensIn: '2' }, { signatureVersion: 'unknown' }
  ])('починка сохраняет строку неверного типа буквально: %j', (invalid) => {
    const cache = makeCache([entry({ build: 2, testsRan: false })]);
    const file = path.join(cache, 'journal.jsonl');
    const raw = '  ' + JSON.stringify({ ...entry(), ...invalid, additional: { valuable: true } }) + '  \r';
    writeFileSync(file, raw + '\n' + readFileSync(file, 'utf8'));
    const warn = vi.fn();
    repairJournal(cache, () => null, warn);
    expect(readFileSync(file, 'utf8').split('\n')[0]).toBe(raw);
    expect(readEntries(cache).brokenLines).toEqual([raw]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('непонятные строки'));
  });

  it('повреждённый состав сохраняет запись и не мешает следующей', () => {
    const first = entry({ testSetHash: null, buildUrl: null });
    const cache = makeCache([first, entry({ build: 2, testsRan: false, buildUrl: null })]);
    const report = reportDir(cache, first.job, first.build);
    mkdirSync(path.join(report, 'data', 'test-cases'), { recursive: true });
    mkdirSync(path.join(report, 'widgets'), { recursive: true });
    writeFileSync(path.join(report, 'widgets', 'summary.json'), '{broken');
    const originalLine = readFileSync(path.join(cache, 'journal.jsonl'), 'utf8').split('\n')[0];
    const warn = vi.fn();
    expect(() => repairJournal(cache, (_job, build) => `https://ci.example/${build}`, warn)).not.toThrow();
    expect(readFileSync(path.join(cache, 'journal.jsonl'), 'utf8').split('\n')[0]).toBe(originalLine);
    expect(readEntries(cache).entries[1].buildUrl).toBe('https://ci.example/2');
    expect(warn).toHaveBeenCalled();
  });

  it('record-runs не считает разбор другого сервера своим и не дозаполняет его', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'record-'));
    const profile = path.join(root, 'profile.json');
    writeFileSync(profile, JSON.stringify({ servers: { first: {}, second: { baseUrl: 'https://second.example' } }, defaultServer: 'second' }));
    const config = loadConfig({}, profile);
    appendEntry(config.cacheDir, entry({ server: 'first', env: '', city: '' }));
    const meta: BuildMeta = { number: 1, result: 'FAILURE', timestamp: 1, durationMs: 1,
      artifacts: [], parameters: { env: 'второе' }, commit: null };
    const client = { listAllRuns: vi.fn(() => Promise.resolve([{ number: 1, result: 'FAILURE', timestamp: 1, durationMs: 1 }])),
      getBuildMeta: vi.fn(() => Promise.resolve(meta)) } as unknown as CiClient;
    const result = await recordRuns(client, config, 'second', 'backend/smoke');
    expect(result.needsReview).toEqual([{ number: 1, result: 'FAILURE' }]);
    expect(result.skippedAnalyzed).toBe(0);
    expect(readEntries(config.cacheDir).entries[0].env).toBe('');
    appendEntry(config.cacheDir, entry({ build: 1, env: '', city: '' }), { resolveServer: serverResolver(config) });
    const legacy = await recordRuns(client, config, 'second', 'backend/smoke');
    expect(legacy.skippedAnalyzed).toBe(1);
    expect(readEntries(config.cacheDir).entries[1]).toMatchObject({ server: 'second', env: 'второе' });
  });

  it('отчёт разделяет страницы, ссылки и закрытие проблем по серверу', () => {
    const cache = makeCache([
      entry({ server: 'first' }),
      entry({ server: 'second', fingerprints: [], buildTimestamp: generatedAt.getTime() }),
      entry({ build: 2, fingerprints: [], buildTimestamp: generatedAt.getTime() })
    ]);
    const options = { generatedAt, resolveServer: () => 'second' };
    const output = writeJournalReport(cache, options);
    const generation = generationDir(output);
    const jobs = readData<Array<{ key: string; server: string; openProblems: number }>>(path.join(generation, 'data', 'jobs.js'));
    expect(jobs).toHaveLength(2);
    expect(jobs.find((job) => job.server === 'first')?.openProblems).toBe(1);
    expect(jobs.find((job) => job.server === 'second')?.openProblems).toBe(0);
    expect(new Set(jobs.map((job) => job.key)).size).toBe(2);
    const data = buildData(cache, generatedAt, 14, options.resolveServer);
    for (const run of data.reportEntries) {
      expect(readFileSync(path.join(generation, 'jobs', `${run.jobKey}.html`), 'utf8')).toContain(`${run.jobKey}.js`);
    }
    expect(data.signatures[0].status).toBe('open');
    const app = { innerHTML: '' };
    vm.runInNewContext(readFileSync(path.join(generation, 'app.js'), 'utf8'), {
      window: {
        QA_REPORT_META: { limits: {} },
        QA_REPORT_MONTH: { month: '2026-08', entries: data.reportEntries }
      },
      document: {
        body: { dataset: { reportPage: 'month', root: '../' } },
        getElementById: (id: string) => id === 'app' ? app : { innerHTML: '' }
      }
    });
    expect(app.innerHTML).toContain('<h2>first / backend/smoke</h2>');
    expect(app.innerHTML).toContain('<h2>second / backend/smoke</h2>');
    expect(app.innerHTML.match(/<section>/g)).toHaveLength(2);
  });
});
