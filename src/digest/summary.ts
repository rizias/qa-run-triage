import type { AllureSummary, TestCase } from '../report/types.js';
import { mainRecords } from '../report/read.js';
import type { BuildMeta } from '../ci/client.js';

export interface RunSummary {
  job: string;
  build: number;
  result: string | null;
  testsRan: boolean;
  total: number;
  passed: number;
  failed: number;
  broken: number;
  skipped: number;
  unknown: number;
  recoveredAfterRetry: number;
  retryAttempts: number;
  newFailures: number;
  knownFailures: number;
  durationMs: number;
  infraFailure: boolean;
  infraReason: string | null;
  reportEmpty: boolean;
  parameters: Record<string, string>;
  commit: string | null;
}

export interface SummaryInput {
  job: string;
  build: number;
  cases: TestCase[];
  allure: AllureSummary | null;
  meta: BuildMeta;
  hasReport: boolean;
}

export function buildSummary(input: SummaryInput): RunSummary {
  const base = {
    job: input.job,
    build: input.build,
    result: input.meta.result,
    durationMs: input.meta.durationMs,
    parameters: input.meta.parameters,
    commit: input.meta.commit
  };

  if (!input.hasReport || !input.allure) {
    return {
      ...base,
      testsRan: false,
      total: 0,
      passed: 0,
      failed: 0,
      broken: 0,
      skipped: 0,
      unknown: 0,
      recoveredAfterRetry: 0,
      retryAttempts: 0,
      newFailures: 0,
      knownFailures: 0,
      infraFailure: true,
      infraReason: 'Прогон завершился до создания отчёта: тесты не запускались либо были прерваны',
      reportEmpty: false
    };
  }

  const main = mainRecords(input.cases, input.allure.statistic.total);
  if (main.length === 0) {
    return {
      ...base,
      testsRan: false,
      total: 0,
      passed: 0,
      failed: 0,
      broken: 0,
      skipped: 0,
      unknown: 0,
      recoveredAfterRetry: 0,
      retryAttempts: 0,
      newFailures: 0,
      knownFailures: 0,
      infraFailure: true,
      infraReason: 'Отчёт скачан, но не содержит ни одной записи теста: раннер прогона упал до первого теста',
      reportEmpty: true
    };
  }
  const failed = main.filter((item) => item.status === 'failed');
  const broken = main.filter((item) => item.status === 'broken');
  const passed = main.filter((item) => item.status === 'passed').length;
  const skipped = main.filter((item) => item.status === 'skipped').length;
  const unknown = main.filter((item) => item.status === 'unknown').length;
  assertStatistic('passed', passed, input.allure.statistic.passed);
  assertStatistic('failed', failed.length, input.allure.statistic.failed);
  assertStatistic('broken', broken.length, input.allure.statistic.broken);
  assertStatistic('skipped', skipped, input.allure.statistic.skipped);
  assertStatistic('unknown', unknown, input.allure.statistic.unknown);
  const problem = [...failed, ...broken];

  return {
    ...base,
    testsRan: true,
    total: main.length,
    passed,
    failed: failed.length,
    broken: broken.length,
    skipped,
    unknown,
    recoveredAfterRetry: main.filter(
      (item) => item.status === 'passed' && item.retriesCount > 0
    ).length,
    retryAttempts: input.cases.filter((item) => item.retry).length,
    newFailures: problem.filter((item) => item.newFailed).length,
    knownFailures: problem.filter((item) => !item.newFailed).length,
    infraFailure: false,
    infraReason: null,
    reportEmpty: false
  };
}

function assertStatistic(name: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error(
      `Число ${name} (${actual}) не совпало со сводкой отчёта ` +
        `(${expected}). Разбор отчёта неверен.`
    );
  }
}
