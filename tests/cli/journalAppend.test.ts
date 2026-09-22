import { DEFAULT_ENVIRONMENT } from '../../src/configFields.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from '../../src/config.js';
import { DEFAULT_SETTINGS } from '../../src/settings.js';
import { readEntries } from '../../src/journal/journal.js';
import { runJournalAppend } from '../../src/cli/index.js';

let cacheDir: string;

const config = (): Config => ({
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
  cacheDir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-journal-append-'));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('Запись разбора командой', () => {
  it('записывает разбор и пересобирает отчёт тем же вызовом', async () => {
    const answer = await runJournalAppend(config(), JSON.stringify(green));

    expect(answer).toMatchObject({ saved: true, job: 'backend/smoke', build: 7 });
    expect(typeof answer.report).toBe('string');
    expect(answer.reportError).toBeUndefined();
    expect(readEntries(cacheDir).entries).toMatchObject([{ job: 'backend/smoke', build: 7 }]);
  });

  it('при ошибке сборки отчёта сохраняет запись и возвращает сообщение об ошибке', async () => {
    writeFileSync(path.join(cacheDir, 'journal-report'), 'постороннее', 'utf8');

    const answer = await runJournalAppend(config(), JSON.stringify(green));

    expect(answer.saved).toBe(true);
    expect(answer.report).toBeUndefined();
    expect(answer.reportError).toEqual(expect.stringContaining('journal-report'));
    expect(readEntries(cacheDir).entries).toMatchObject([{ job: 'backend/smoke', build: 7 }]);
  });
});
