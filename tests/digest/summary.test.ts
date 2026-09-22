import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildSummary } from '../../src/digest/summary.js';
import type { TestCase, AllureSummary } from '../../src/report/types.js';
import type { BuildMeta } from '../../src/ci/client.js';

const root = path.join(process.cwd(), 'tests', 'fixtures', 'run-30');

function fixture(name: string): TestCase {
  return JSON.parse(
    readFileSync(path.join(root, 'test-cases', `${name}.json`), 'utf8')
  ) as TestCase;
}

const meta: BuildMeta = {
  number: 30,
  result: 'FAILURE',
  timestamp: 0,
  durationMs: 1098000,
  artifacts: ['allure-report.zip'],
  parameters: { env: 'stage', city: 'spb' },
  commit: '59f57b67d68070064b7b682a1f3a467599c71c2c'
};

const allure: AllureSummary = {
  statistic: { failed: 2, broken: 0, skipped: 1, passed: 2, unknown: 0, total: 5 },
  time: { duration: 991412 }
};

const cases = [
  fixture('failed-main'),
  fixture('failed-main-2'),
  fixture('failed-retry'),
  fixture('recovered'),
  fixture('passed'),
  fixture('skipped')
];

describe('Сводка прогона', () => {
  it('не считает попытки перезапуска отдельными тестами', () => {
    const summary = buildSummary({ job: 'backend/all-tests', build: 30, cases, allure, meta, hasReport: true });
    expect(summary.total).toBe(5);
  });

  it('считает упавшими только основные записи', () => {
    const summary = buildSummary({ job: 'backend/all-tests', build: 30, cases, allure, meta, hasReport: true });
    expect(summary.failed).toBe(2);
  });

  it('выделяет прошедших после перезапуска в отдельное число', () => {
    const summary = buildSummary({ job: 'backend/all-tests', build: 30, cases, allure, meta, hasReport: true });
    expect(summary.recoveredAfterRetry).toBe(1);
  });

  it('считает recoveredAfterRetry подмножеством passed', () => {
    const input: AllureSummary = {
      statistic: { failed: 0, broken: 0, skipped: 0, passed: 2, unknown: 0, total: 2 },
      time: { duration: 1 }
    };
    const summary = buildSummary({
      job: 'backend/smoke',
      build: 22,
      cases: [fixture('passed'), fixture('recovered')],
      allure: input,
      meta,
      hasReport: true
    });

    expect(summary.passed).toBe(2);
    expect(summary.recoveredAfterRetry).toBe(1);
  });

  it('считает попытки перезапуска', () => {
    const summary = buildSummary({ job: 'backend/all-tests', build: 30, cases, allure, meta, hasReport: true });
    expect(summary.retryAttempts).toBe(1);
  });

  it('называет расхождение total и оба числа', () => {
    const wrong: AllureSummary = {
      statistic: { failed: 2, broken: 0, skipped: 1, passed: 2, unknown: 0, total: 99 },
      time: { duration: 1 }
    };
    expect(() =>
      buildSummary({ job: 'backend/all-tests', build: 30, cases, allure: wrong, meta, hasReport: true })
    ).toThrow(/total.*5.*99/);
  });

  it('проверяет расхождение passed при совпавшем total', () => {
    const wrong: AllureSummary = {
      statistic: { failed: 2, broken: 0, skipped: 1, passed: 1, unknown: 0, total: 5 },
      time: { duration: 1 }
    };

    expect(() =>
      buildSummary({ job: 'backend/all-tests', build: 30, cases, allure: wrong, meta, hasReport: true })
    ).toThrow(/passed.*2.*1/);
  });

  it('проверяет расхождение failed при совпавшем total', () => {
    const wrong: AllureSummary = {
      statistic: { failed: 1, broken: 0, skipped: 1, passed: 2, unknown: 0, total: 5 },
      time: { duration: 1 }
    };

    expect(() =>
      buildSummary({ job: 'backend/all-tests', build: 30, cases, allure: wrong, meta, hasReport: true })
    ).toThrow(/failed.*2.*1/);
  });

  it('проверяет расхождение broken при совпавшем total', () => {
    const wrong: AllureSummary = {
      statistic: { failed: 2, broken: 1, skipped: 1, passed: 2, unknown: 0, total: 5 },
      time: { duration: 1 }
    };

    expect(() =>
      buildSummary({ job: 'backend/all-tests', build: 30, cases, allure: wrong, meta, hasReport: true })
    ).toThrow(/broken.*0.*1/);
  });

  it('проверяет расхождение skipped при совпавшем total', () => {
    const wrong: AllureSummary = {
      statistic: { failed: 2, broken: 0, skipped: 0, passed: 2, unknown: 0, total: 5 },
      time: { duration: 1 }
    };

    expect(() =>
      buildSummary({ job: 'backend/all-tests', build: 30, cases, allure: wrong, meta, hasReport: true })
    ).toThrow(/skipped.*1.*0/);
  });

  it('учитывает статус unknown отдельным числом', () => {
    const unknown: AllureSummary = {
      statistic: { failed: 0, broken: 0, skipped: 0, passed: 0, unknown: 1, total: 1 },
      time: { duration: 1 }
    };
    const summary = buildSummary({
      job: 'backend/smoke',
      build: 22,
      cases: [{ ...fixture('passed'), uid: 'unknown', status: 'unknown' }],
      allure: unknown,
      meta,
      hasReport: true
    });

    expect(summary.unknown).toBe(1);
  });

  it('отмечает сбой до тестов, когда отчёта нет', () => {
    const summary = buildSummary({
      job: 'backend/all-tests',
      build: 30,
      cases: [],
      allure: null,
      meta: { ...meta, artifacts: [] },
      hasReport: false
    });
    expect(summary.testsRan).toBe(false);
    expect(summary.infraFailure).toBe(true);
    expect(summary.infraReason).toContain('отчёт');
  });

  it('не выдумывает падений на успешном прогоне', () => {
    const green: AllureSummary = {
      statistic: { failed: 0, broken: 0, skipped: 0, passed: 1, unknown: 0, total: 1 },
      time: { duration: 1 }
    };
    const summary = buildSummary({
      job: 'backend/smoke',
      build: 22,
      cases: [fixture('passed')],
      allure: green,
      meta: { ...meta, result: 'SUCCESS' },
      hasReport: true
    });
    expect(summary.failed).toBe(0);
    expect(summary.recoveredAfterRetry).toBe(0);
  });
});
