import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeJournalReport } from '../../src/htmlreport/report.js';
import { REPORT_FORMAT, DEFAULT_SETTINGS } from '../../src/settings.js';
import { type JournalEntry, appendEntry, type JournalEntryInput } from '../../src/journal/journal.js';
import { toCacheKey } from '../../src/fetcher/cachePaths.js';
import { entry, exactSignature, generatedAt, generationDir, makeCache, readData } from './fixtures.js';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const renameSync = vi.fn(actual.renameSync);
  return { ...actual, renameSync, default: { ...actual, renameSync } };
});

afterEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(fs.renameSync).mockReset();
  vi.mocked(fs.renameSync).mockImplementation(actual.renameSync);
});

type StatusIndex = Array<{ id: string; status: string }>;

function signatureStatuses(entries: JournalEntry[]): StatusIndex {
  const cacheDir = makeCache(entries);
  const outputDir = mkdtempSync(path.join(os.tmpdir(), 'qa-report-out-'));
  writeJournalReport(cacheDir, { outDir: outputDir, generatedAt });
  return readData<StatusIndex>(
    path.join(generationDir(outputDir), 'data', 'signatures', 'index.js')
  );
}

describe('указатель поколения', () => {
  it('заменяет current.js переименованием готового временного файла', () => {
    const cacheDir = makeCache([entry({ build: 1 })]);
    const outputDir = mkdtempSync(path.join(os.tmpdir(), 'qa-report-out-'));

    writeJournalReport(cacheDir, { outDir: outputDir, generatedAt });

    const targets = vi.mocked(fs.renameSync).mock.calls.map((call) => String(call[1]));
    expect(targets.some((target) => target.endsWith('current.js'))).toBe(true);
    expect(readdirSync(outputDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('неполные записи', () => {
  it('помечает запись без окружения как неполную', () => {
    const cacheDir = makeCache([
      entry({ build: 1, env: 'stage' }),
      entry({ build: 2, env: '' })
    ]);
    const outputDir = mkdtempSync(path.join(os.tmpdir(), 'qa-report-out-'));
    writeJournalReport(cacheDir, { outDir: outputDir, generatedAt, settings: { ...DEFAULT_SETTINGS, reportTimeZone: 'Etc/UTC' } });

    const august = readData<{ entries: Array<{ build: number; incomplete: boolean }> }>(
      path.join(generationDir(outputDir), 'data', 'months', '2026-08.js')
    );

    expect(august.entries.find((item) => item.build === 1)?.incomplete).toBe(false);
    expect(august.entries.find((item) => item.build === 2)?.incomplete).toBe(true);
  });

  it('считает неполные записи в сводке отчёта', () => {
    const cacheDir = makeCache([
      entry({ build: 1, env: 'stage' }),
      entry({ build: 2, env: '' }),
      entry({ build: 3, env: '' })
    ]);
    const outputDir = mkdtempSync(path.join(os.tmpdir(), 'qa-report-out-'));
    writeJournalReport(cacheDir, { outDir: outputDir, generatedAt });

    const meta = readData<{ incompleteEntries: number }>(
      path.join(generationDir(outputDir), 'data', 'meta.js')
    );

    expect(meta.incompleteEntries).toBe(2);
  });
});

describe('статус проблемы', () => {
  it('прогон без выполненных тестов не закрывает проблему', () => {
    const statuses = signatureStatuses([
      entry({ build: 1, analyzedAt: '2026-08-01T00:00:00.000Z' }),
      entry({
        build: 2,
        analyzedAt: '2026-08-02T00:00:00.000Z',
        testsRan: false,
        result: null,
        total: null,
        failed: null,
        fingerprints: []
      })
    ]);

    expect(statuses).toHaveLength(1);
    expect(statuses[0].status).toBe('open');
  });

  it('зелёный прогон того же окружения закрывает проблему', () => {
    const statuses = signatureStatuses([
      entry({ build: 1, analyzedAt: '2026-08-01T00:00:00.000Z' }),
      entry({
        build: 2,
        analyzedAt: '2026-08-02T00:00:00.000Z',
        result: 'SUCCESS',
        failed: 0,
        fingerprints: []
      })
    ]);

    expect(statuses[0].status).toBe('gone');
  });

  it('запись без окружения не закрывает проблему', () => {
    const statuses = signatureStatuses([
      entry({ build: 1, analyzedAt: '2026-08-01T00:00:00.000Z' }),
      entry({
        build: 2,
        analyzedAt: '2026-08-02T00:00:00.000Z',
        env: '',
        result: 'SUCCESS',
        failed: 0,
        fingerprints: []
      })
    ]);

    expect(statuses[0].status).toBe('open');
  });
});

function snapshot(root: string, relative = ''): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  for (const item of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, item.name);
    if (item.isDirectory()) {
      for (const [name, bytes] of snapshot(root, child)) result.set(name, bytes);
    } else {
      result.set(child, readFileSync(path.join(root, child)));
    }
  }
  return result;
}

function renderApp(
  generation: string,
  page: string,
  globals: Record<string, unknown>
): string {
  const app = { innerHTML: '', textContent: '' };
  const nav = { innerHTML: '' };
  const controls = new Map<string, { onclick?: () => void; addEventListener: () => void }>();
  const document = {
    body: { dataset: { reportPage: page, root: page === 'dashboard' ? '' : '../' } },
    getElementById(id: string) {
      if (id === 'app') return app;
      if (id === 'nav') return nav;
      const control = controls.get(id) ?? { addEventListener() {} };
      controls.set(id, control);
      return control;
    },
    querySelectorAll: () => []
  };
  const window = { ...globals } as Record<string, unknown>;
  vm.runInNewContext(readFileSync(path.join(generation, 'app.js'), 'utf8'), {
    window,
    document,
    Intl,
    Date,
    Number,
    String,
    Array,
    Set,
    Object,
    Math,
    encodeURIComponent
  });
  return app.innerHTML;
}

describe('Сборка отчёта журнала', () => {
  it('создаёт полное поколение с отдельными файлами данных и тонкими HTML', () => {
    const goneSignature = 'Ушедшая проблема';
    const legacySignature = 'legacy value';
    const cacheDir = makeCache([
      entry(),
      entry({
        build: 2,
        analyzedAt: '2026-08-02T00:00:00.000Z',
        buildTimestamp: Date.parse('2026-08-02T00:00:00.000Z'),
        result: 'SUCCESS',
        failed: 0,
        fingerprints: []
      }),
      entry({
        build: 3,
        analyzedAt: '2026-08-03T00:00:00.000Z',
        buildTimestamp: Date.parse('2026-08-03T00:00:00.000Z'),
        env: 'prod',
        fingerprints: [exactSignature]
      }),
      entry({
        job: 'backend/other',
        build: 4,
        analyzedAt: '2026-07-31T00:00:00.000Z',
        buildTimestamp: Date.parse('2026-07-31T00:00:00.000Z'),
        fingerprints: [goneSignature]
      }),
      entry({
        job: 'backend/other',
        build: 5,
        analyzedAt: '2026-08-04T00:00:00.000Z',
        buildTimestamp: Date.parse('2026-08-04T00:00:00.000Z'),
        result: 'SUCCESS',
        failed: 0,
        fingerprints: []
      }),
      entry({
        job: 'backend/legacy',
        build: 6,
        analyzedAt: '2026-08-05T00:00:00.000Z',
        buildTimestamp: null,
        signatureVersion: 'legacy',
        fingerprints: [legacySignature]
      })
    ], true);
    const outputDir = path.join(cacheDir, 'report-out');
    writeFileSync(path.join(cacheDir, 'journal.html'), 'legacy report', 'utf8');

    expect(writeJournalReport(cacheDir, { outDir: outputDir, generatedAt, settings: { ...DEFAULT_SETTINGS, reportTimeZone: 'Etc/UTC' } })).toBe(outputDir);
    const generation = generationDir(outputDir);
    const smokeKey = toCacheKey('backend/smoke');
    const exactId = createHash('sha256').update(exactSignature).digest('hex').slice(0, 16);
    const goneId = createHash('sha256').update(goneSignature).digest('hex').slice(0, 16);
    const legacyId = createHash('sha256').update(legacySignature).digest('hex').slice(0, 16);
    const required = [
      'index.html', 'style.css', 'app.js', 'data/meta.js', 'data/jobs.js',
      'data/months/2026-07.js', 'data/months/2026-08.js',
      `data/jobs/${smokeKey}.js`, 'data/signatures/index.js',
      `data/signatures/${exactId}.js`,      `jobs/${smokeKey}.html`, 'signatures/index.html',
      `signatures/${exactId}.html`, 'archive/index.html', 'archive/2026-08.html'
    ];
    expect(required.every((file) => readFileSync(path.join(generation, file)).length > 0)).toBe(true);
    expect(readFileSync(path.join(cacheDir, 'journal.html'), 'utf8')).toBe('legacy report');

    const dashboardHtml = readFileSync(path.join(generation, 'index.html'), 'utf8');
    const jobHtml = readFileSync(path.join(generation, 'jobs', `${smokeKey}.html`), 'utf8');
    expect(dashboardHtml).toContain('<script src="data/meta.js"></script>');
    expect(jobHtml).toContain(`<script src="../data/jobs/${smokeKey}.js"></script>`);
    expect(dashboardHtml).not.toContain('backend/smoke');
    expect(dashboardHtml).not.toContain(exactSignature);

    type Meta = { windowDays: number; timeZone: string; utcOffset: string; skippedLines: number; months: string[] };
    type JobData = { runs: Array<{ build: number; signatures: Array<{ id: string }>; city: string }> };
    type MonthData = { entries: Array<{ job: string; build: number; signatures: Array<{ id: string }> }> };
    type SeriesIndex = Array<{ id: string; status: string; legacy: boolean; pairs: Array<{ job: string; env: string; status: string }> }>;
    type Series = { text: string; occurrences: Array<{ job: string; build: number }> };
    const meta = readData<Meta>(path.join(generation, 'data', 'meta.js'));
    const job = readData<JobData>(path.join(generation, 'data', 'jobs', `${smokeKey}.js`));
    const july = readData<MonthData>(path.join(generation, 'data', 'months', '2026-07.js'));
    const august = readData<MonthData>(path.join(generation, 'data', 'months', '2026-08.js'));
    const signatures = readData<SeriesIndex>(path.join(generation, 'data', 'signatures', 'index.js'));
    const exact = readData<Series>(path.join(generation, 'data', 'signatures', `${exactId}.js`));

    expect(meta).toMatchObject({ windowDays: 14, timeZone: 'Etc/UTC', utcOffset: 'UTC', skippedLines: 1 });
    expect(meta.months).toEqual(['2026-08', '2026-07']);
    expect(job.runs).toHaveLength(3);
    expect(job.runs[2].signatures[0].id).toBe(exactId);
    expect(job.runs[2].city).toBe('spb <x>');
    expect([...july.entries, ...august.entries].filter((item) => item.job === 'backend/smoke')).toHaveLength(job.runs.length);
    expect(exact.text).toBe(exactSignature);
    expect(exact.occurrences.map((item) => item.build)).toEqual([1, 3]);

    const exactIndex = signatures.find((item) => item.id === exactId)!;
    expect(exactIndex.status).toBe('open');
    expect(exactIndex.pairs).toEqual(expect.arrayContaining([
      expect.objectContaining({ job: 'backend/smoke', env: 'stage', status: 'gone' }),
      expect.objectContaining({ job: 'backend/smoke', env: 'prod', status: 'open' })
    ]));
    expect(signatures.find((item) => item.id === goneId)?.status).toBe('gone');
    expect(signatures.find((item) => item.id === legacyId)).toMatchObject({ status: 'open', legacy: true });

    const rendered = renderApp(generation, 'signature', {
      QA_REPORT_META: { ...meta, limits: { signatureOccurrences: 200 } },
      QA_REPORT_SIGNATURE: readData(path.join(generation, 'data', 'signatures', `${exactId}.js`))
    });
    expect(rendered).toContain('Element &lt;button&gt; missing\nSecond LINE &amp; detail');
    expect(rendered).not.toContain('Element <button>');
  });

  it('публикует поколения без порчи первого и сохраняет предыдущий указатель', () => {
    const cacheDir = makeCache([entry()]);
    const outputDir = path.join(cacheDir, 'out');
    mkdirSync(outputDir);
    writeFileSync(path.join(outputDir, 'keep.txt'), 'старый формат', { encoding: 'utf8', flag: 'wx' });
    writeFileSync(path.join(outputDir, 'index.html'), 'old index', 'utf8');
    writeFileSync(path.join(outputDir, 'current.js'), 'window.QA_REPORT_CURRENT = "legacy/index.html";\n', 'utf8');

    writeJournalReport(cacheDir, { outDir: outputDir, generatedAt });
    const firstGeneration = generationDir(outputDir);
    const firstBytes = snapshot(firstGeneration);
    const firstCurrent = readFileSync(path.join(outputDir, 'current.js'), 'utf8');

    writeJournalReport(cacheDir, {
      outDir: outputDir,
      generatedAt: new Date('2026-08-07T00:01:00.000Z')
    });

    expect(readFileSync(path.join(outputDir, 'keep.txt'), 'utf8')).toBe('старый формат');
    for (const [file, bytes] of firstBytes) {
      expect(readFileSync(path.join(firstGeneration, file))).toEqual(bytes);
    }
    expect(generationDir(outputDir)).not.toBe(firstGeneration);
    expect(readFileSync(path.join(outputDir, 'current.js.prev-20260807T000100000Z'), 'utf8')).toBe(firstCurrent);
    expect(readFileSync(path.join(outputDir, 'current.js.prev-20260807T000000000Z'), 'utf8')).toBe('window.QA_REPORT_CURRENT = "legacy/index.html";\n');
  });

  it('применяет потолки только при показе, оставляя в данных всю историю', () => {
    const entries = Array.from({ length: 520 }, (_, index) => entry({
      build: index + 1,
      analyzedAt: new Date(generatedAt.getTime() - index * 1000).toISOString(),
      buildTimestamp: generatedAt.getTime() - index * 1000,
      env: `env-${index % 60}`,
      fingerprints: [`Problem ${index % 60}`, 'Common problem']
    }));
    const cacheDir = makeCache(entries);
    const outputDir = path.join(cacheDir, 'out');
    writeJournalReport(cacheDir, { outDir: outputDir, generatedAt });
    const generation = generationDir(outputDir);
    const meta = readData<Record<string, unknown>>(path.join(generation, 'data', 'meta.js'));
    const jobs = readData<unknown[]>(path.join(generation, 'data', 'jobs.js'));
    const job = readData<{ runs: unknown[] }>(path.join(generation, 'data', 'jobs', `${toCacheKey('backend/smoke')}.js`));
    const signatures = readData<unknown[]>(path.join(generation, 'data', 'signatures', 'index.js'));
    const commonId = createHash('sha256').update('Common problem').digest('hex').slice(0, 16);
    const common = readData<Record<string, unknown>>(path.join(generation, 'data', 'signatures', `${commonId}.js`));
    const august = readData<{ entries: unknown[] }>(path.join(generation, 'data', 'months', '2026-08.js'));

    expect(job.runs).toHaveLength(520);
    expect(august.entries).toHaveLength(520);
    expect((common.occurrences as unknown[])).toHaveLength(520);
    const dashboard = renderApp(generation, 'dashboard', {
      QA_REPORT_META: meta,
      QA_REPORT_JOBS: jobs,
      QA_REPORT_SIGNATURES: signatures,
      QA_REPORT_MONTHS: [august]
    });
    const jobPage = renderApp(generation, 'job', {
      QA_REPORT_META: meta,
      QA_REPORT_JOB: { job: 'backend/smoke', runs: job.runs },
      QA_REPORT_SIGNATURES: signatures
    });
    const signaturePage = renderApp(generation, 'signature', {
      QA_REPORT_META: meta,
      QA_REPORT_SIGNATURE: common
    });
    expect((dashboard.match(/class="open-problem"/g) ?? [])).toHaveLength(50);
    expect((dashboard.match(/class="window-entry/g) ?? [])).toHaveLength(50);
    expect((jobPage.match(/id="b-/g) ?? [])).toHaveLength(500);
    expect((signaturePage.match(/<tbody><tr>/g) ?? [])).toHaveLength(1);
    expect((signaturePage.match(/<tr>/g) ?? []).length - (signaturePage.match(/<thead><tr>/g) ?? []).length).toBe(200);
  });

  it('yearStart равен generatedAt минус окно истории', () => {
    const cacheDir = makeCache([entry()]);
    const outputDir = mkdtempSync(path.join(os.tmpdir(), 'qa-report-out-'));
    writeJournalReport(cacheDir, { outDir: outputDir, generatedAt });
    const meta = readData<{ yearStart: number }>(
      path.join(generationDir(outputDir), 'data', 'meta.js')
    );
    expect(meta.yearStart).toBe(
      generatedAt.getTime() - REPORT_FORMAT.historyDays * 24 * 60 * 60 * 1000
    );
  });

});


describe('Пределы выбранного профиля', () => {
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

  it('Замок журнала и окно отчёта берутся из выбранного профиля', () => {
      const cacheDir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-rf-report-'));
      const outDir = path.join(cacheDir, 'out');
      try {
        appendEntry(cacheDir, journalEntry());
        writeJournalReport(cacheDir, {
          outDir,
          generatedAt: new Date('2026-08-15T00:00:00.000Z'),
          settings: { ...DEFAULT_SETTINGS, reportWindowDays: 3 }
        });
        const generation = readdirSync(path.join(outDir, 'gens'))[0];
        const metaJs = readFileSync(path.join(outDir, 'gens', generation, 'data', 'meta.js'), 'utf8');
        expect(metaJs).toContain('"windowDays":3');
      } finally {
        rmSync(cacheDir, { recursive: true, force: true });
      }
    });
});
