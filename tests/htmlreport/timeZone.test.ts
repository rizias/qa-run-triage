import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { COMMAND_HANDLERS } from '../../src/cli/commands.js';
import { parseArgs, runJournalAppend } from '../../src/cli/index.js';
import { writeJournalReport } from '../../src/htmlreport/report.js';
import { DEFAULT_SETTINGS } from '../../src/settings.js';
import { entry, generationDir, makeCache, readData } from './fixtures.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function renderDashboard(generation: string): string {
  const app = { innerHTML: '' };
  const nav = { innerHTML: '' };
  const context = vm.createContext({
    window: {},
    document: {
      body: { dataset: { reportPage: 'dashboard', root: '' } },
      getElementById: (id: string) => id === 'app' ? app : nav
    }
  });
  const html = readFileSync(path.join(generation, 'index.html'), 'utf8');
  for (const match of html.matchAll(/<script(?: src="([^"]+)")?>([\s\S]*?)<\/script>/g)) {
    const script = match[1] ? readFileSync(path.join(generation, match[1]), 'utf8') : match[2];
    vm.runInContext(script, context);
  }
  return `${nav.innerHTML}\n${app.innerHTML}`;
}

describe('Часовой пояс страниц и архива из спецификации отчёта', () => {
  it.each([
    ['Etc/UTC', '31.01.2026 23:30', '2026-01', 'UTC'],
    ['Asia/Tokyo', '01.02.2026 08:30', '2026-02', 'UTC+9'],
    ['America/New_York', '31.01.2026 18:30', '2026-01', 'UTC-5']
  ])('команда report использует %s для времени и месяца', async (timeZone, timestamp, month, utcOffset) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-02-01T00:00:00Z'));
    const cache = makeCache([entry({ buildTimestamp: Date.parse('2026-01-31T23:30:00Z') })]);
    const file = path.join(cache, 'profile.json');
    writeFileSync(file, JSON.stringify({ report: { timeZone } }));
    const config = loadConfig({ QA_RUN_TRIAGE_CACHE_DIR: cache }, file);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await COMMAND_HANDLERS.report(config, parseArgs(['report'], config.settings));
    const generation = generationDir(path.join(cache, 'journal-report'));
    const meta = readData<Record<string, unknown>>(path.join(generation, 'data', 'meta.js'));
    expect(meta).toMatchObject({ timeZone, utcOffset, months: [month] });
    const monthly = readData<{ entries: Array<{ build: number }> }>(path.join(generation, 'data', 'months', `${month}.js`));
    expect(monthly.entries).toMatchObject([{ build: 1 }]);
    const html = renderDashboard(generation);
    expect(html).toContain(timestamp);
    expect(html).toContain(`${timeZone} (${utcOffset})`);
  });

  it('поколение без явного пояса сохраняет пояс машины сборки', () => {
    const cache = makeCache([]);
    const out = writeJournalReport(cache);
    const meta = readData<{ timeZone: string }>(path.join(generationDir(out), 'data', 'meta.js'));
    expect(meta.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it.each([
    ['2026-01-15T12:00:00Z', 'UTC-5'],
    ['2026-07-15T12:00:00Z', 'UTC-4']
  ])('подпись времени сборки %s учитывает сезонное смещение', (date, offset) => {
    const cache = makeCache([]);
    const out = writeJournalReport(cache, {
      generatedAt: new Date(date),
      settings: { ...DEFAULT_SETTINGS, reportTimeZone: 'America/New_York' }
    });
    const html = renderDashboard(generationDir(out));
    expect(html).toContain(`America/New_York (${offset})`);
  });

  it('journal-append пересобирает отчёт с поясом выбранного профиля', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qa-journal-zone-'));
    const file = path.join(dir, 'profile.json');
    writeFileSync(file, JSON.stringify({ report: { timeZone: 'Asia/Tokyo' } }));
    const config = loadConfig({}, file);
    const answer = await runJournalAppend(config, JSON.stringify({
      job: 'folder/example-job', build: 1, testsRan: false, recoveredAfterRetry: 0, verdict: 'Сбой до запуска тестов'
    }));
    expect(answer.saved).toBe(true);
    expect(answer.reportError).toBeUndefined();
    const meta = readData<{ timeZone: string }>(path.join(generationDir(answer.report as string), 'data', 'meta.js'));
    expect(meta.timeZone).toBe('Asia/Tokyo');
  });
});
