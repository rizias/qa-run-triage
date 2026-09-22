import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS, REPORT_FORMAT, loadSettings } from '../src/settings.js';

function tempConfigFile(contents: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-settings-'));
  const file = path.join(dir, 'profile.json');
  writeFileSync(file, JSON.stringify(contents), 'utf8');
  return file;
}

const noConfigFile = tempConfigFile({});

describe('Числовые настройки', () => {
  it('собирает все числа-решения в именованные настройки со штатными значениями', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      reportTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      cacheKeepRuns: 20,
      fingerprintLookbackDays: 30,
      downloadTimeoutMs: 120_000,
      requestTimeoutMs: 30_000,
      runListDefault: 20,
      runListMax: 50,
      journalLockPollMs: 20,
      journalLockTimeoutMs: 5_000,
      reportWindowDays: 14,
      archiveMaxBytes: 2_147_483_648,
      journalInputMaxBytes: 1_048_576
    });
    expect(REPORT_FORMAT).toEqual({
      historyDays: 365,
      showLimits: {
        jobEntries: 500,
        openProblems: 50,
        signatureOccurrences: 200,
        windowEntries: 50
      },
      signatureIdLength: 16,
      signaturePreviewLength: 80,
      verdictPreviewLength: 120
    });
  });

  it('переопределяет эксплуатационные решения положительными целыми из окружения', () => {
    const settings = loadSettings({
      QA_RUN_TRIAGE_CACHE_KEEP_RUNS: '7',
      QA_RUN_TRIAGE_FINGERPRINT_LOOKBACK_DAYS: '9',
      QA_RUN_TRIAGE_DOWNLOAD_TIMEOUT_MS: '800',
      QA_RUN_TRIAGE_REQUEST_TIMEOUT_MS: '300',
      QA_RUN_TRIAGE_RUN_LIST_DEFAULT: '6',
      QA_RUN_TRIAGE_RUN_LIST_MAX: '12',
      QA_RUN_TRIAGE_JOURNAL_LOCK_POLL_MS: '2',
      QA_RUN_TRIAGE_JOURNAL_LOCK_TIMEOUT_MS: '40',
      QA_RUN_TRIAGE_REPORT_WINDOW_DAYS: '21',
      QA_RUN_TRIAGE_ARCHIVE_MAX_BYTES: '4096',
      QA_RUN_TRIAGE_JOURNAL_INPUT_MAX_BYTES: '2048'
    }, noConfigFile);

    expect(settings).toEqual({
      reportTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      cacheKeepRuns: 7,
      fingerprintLookbackDays: 9,
      downloadTimeoutMs: 800,
      requestTimeoutMs: 300,
      runListDefault: 6,
      runListMax: 12,
      journalLockPollMs: 2,
      journalLockTimeoutMs: 40,
      reportWindowDays: 21,
      archiveMaxBytes: 4096,
      journalInputMaxBytes: 2048
    });
  });

  it('неизвестная переменная с префиксом продукта не читается', () => {
    const settings = loadSettings({
      QA_RUN_TRIAGE_UNKNOWN_SETTING: '111'
    }, noConfigFile);
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it('пустая переменная предела — ошибка', () => {
    expect(() =>
      loadSettings({ QA_RUN_TRIAGE_CACHE_KEEP_RUNS: '' }, noConfigFile)
    ).toThrow('QA_RUN_TRIAGE_CACHE_KEEP_RUNS');
  });

  it('предел из блока limits файла настроек применяется без переменной', () => {
    const file = tempConfigFile({ limits: { cacheKeepRuns: 3 } });

    expect(loadSettings({}, file).cacheKeepRuns).toBe(3);
  });

  it('переменная перекрывает предел из файла', () => {
    const file = tempConfigFile({ limits: { cacheKeepRuns: 3 } });

    expect(
      loadSettings({ QA_RUN_TRIAGE_CACHE_KEEP_RUNS: '9' }, file).cacheKeepRuns
    ).toBe(9);
  });

  it('называет оба поля, когда предел списка прогонов по умолчанию больше предела максимума', () => {
    expect(() =>
      loadSettings({
        QA_RUN_TRIAGE_RUN_LIST_DEFAULT: '60',
        QA_RUN_TRIAGE_RUN_LIST_MAX: '50'
      }, noConfigFile)
    ).toThrow(/runListDefault/);
  });
});
