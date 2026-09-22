import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { AllureSummary, TestCase } from './types.js';

export function mainRecords(cases: TestCase[], expectedTotal?: number): TestCase[] {
  const main = cases.filter(
    (testCase) => testCase.retry !== true && testCase.hidden !== true
  );
  if (expectedTotal !== undefined && main.length !== expectedTotal) {
    throw new Error(
      `Число основных записей по statistic.total не совпало: ` +
        `прочитано ${main.length}, в сводке ${expectedTotal}.`
    );
  }
  return main;
}

export function readMainRecords(reportDir: string): TestCase[] {
  const cases = readTestCases(reportDir);
  return mainRecords(cases, readAllureSummary(reportDir).statistic.total);
}

export function readTestCases(reportDir: string): TestCase[] {
  const dir = path.join(reportDir, 'data', 'test-cases');
  if (!existsSync(dir)) {
    return [];
  }
  const invalidRetryFiles: string[] = [];
  const cases = readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => {
      const file = path.join(dir, name);
      try {
        const testCase = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        if (
          Object.prototype.hasOwnProperty.call(testCase, 'retry') &&
          typeof testCase.retry !== 'boolean'
        ) {
          invalidRetryFiles.push(name);
        }
        return testCase as unknown as TestCase;
      } catch (cause) {
        throw new Error(`Не удалось разобрать JSON-файл отчёта: ${file}`, { cause });
      }
    });
  if (invalidRetryFiles.length > 0) {
    throw new Error(
      `Поле retry должно быть логическим значением. Файлы: ${invalidRetryFiles.join(', ')}`
    );
  }
  return cases;
}

export function readAllureSummary(reportDir: string): AllureSummary {
  const file = path.join(reportDir, 'widgets', 'summary.json');
  if (!existsSync(file)) {
    throw new Error(`В кэше нет сводки отчёта: ${file}`);
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as AllureSummary;
  } catch (cause) {
    throw new Error(`Не удалось разобрать JSON-файл отчёта: ${file}`, { cause });
  }
}

export function labelOf(testCase: TestCase, name: string): string | null {
  const label = testCase.labels.find((item) => item.name === name);
  return label ? label.value : null;
}
