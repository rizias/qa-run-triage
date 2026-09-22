import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  labelOf,
  mainRecords,
  readAllureSummary,
  readTestCases,
} from '../../src/report/read.js';
import type { TestCase } from '../../src/report/types.js';

const fixtureRoot = path.join(process.cwd(), 'tests', 'fixtures', 'run-30');
const testCasesFixtureDir = path.join(fixtureRoot, 'test-cases');
let reportDir!: string;

beforeEach(() => {
  reportDir = mkdtempSync(path.join(os.tmpdir(), 'qa-run-triage-report-'));
});

afterEach(() => {
  rmSync(reportDir, { force: true, recursive: true });
});

function fixture(name: string): TestCase {
  return JSON.parse(readFileSync(path.join(testCasesFixtureDir, `${name}.json`), 'utf8')) as TestCase;
}

function copyFixture(source: string, destination: string): string {
  const destinationPath = path.join(reportDir, destination);
  mkdirSync(path.dirname(destinationPath), { recursive: true });
  writeFileSync(
    destinationPath,
    readFileSync(path.join(fixtureRoot, source), 'utf8'),
    'utf8'
  );
  return destinationPath;
}

describe('Основные записи тестов', () => {
  it('исключает записи попыток перезапуска', () => {
    const cases = [fixture('failed-main'), fixture('failed-retry')];
    const result = mainRecords(cases);
    expect(result).toHaveLength(1);
    expect(result[0].retry).toBe(false);
  });

  it('оставляет прошедший после перезапуска тест', () => {
    const result = mainRecords([fixture('recovered')]);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('passed');
    expect(result[0].retriesCount).toBeGreaterThan(0);
  });

  it('оставляет пропущенный тест', () => {
    const result = mainRecords([fixture('skipped')]);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('skipped');
  });

  it('считает основной запись без поля retry', () => {
    const withoutRetry = { ...fixture('passed') };
    delete withoutRetry.retry;

    expect(mainRecords([withoutRetry])).toHaveLength(1);
  });

  it('исключает скрытую запись', () => {
    const hidden = { ...fixture('passed'), hidden: true };

    expect(mainRecords([hidden])).toHaveLength(0);
  });

  it('называет оба числа при расхождении со statistic.total', () => {
    expect(() => mainRecords([fixture('passed')], 2)).toThrow(/total.*1.*2/);
  });
});

describe('Чтение тестов', () => {
  it('читает все JSON-записи из каталога', () => {
    copyFixture('test-cases/passed.json', path.join('data', 'test-cases', 'passed.json'));
    copyFixture('test-cases/skipped.json', path.join('data', 'test-cases', 'skipped.json'));

    const result = readTestCases(reportDir);

    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'passed' }),
        expect.objectContaining({ status: 'skipped' }),
      ])
    );
  });

  it('возвращает пустой список при отсутствующем каталоге записей', () => {
    expect(readTestCases(reportDir)).toEqual([]);
  });

  it('пропускает файлы, не являющиеся JSON', () => {
    copyFixture('test-cases/passed.json', path.join('data', 'test-cases', 'passed.json'));
    const notePath = path.join(reportDir, 'data', 'test-cases', 'notes.txt');
    writeFileSync(notePath, 'это не JSON', 'utf8');

    expect(readTestCases(reportDir)).toHaveLength(1);
  });

  it('называет повреждённый JSON-файл в ошибке', () => {
    const brokenPath = path.join(reportDir, 'data', 'test-cases', 'broken.json');
    mkdirSync(path.dirname(brokenPath), { recursive: true });
    writeFileSync(brokenPath, '{ broken', 'utf8');

    expect(() => readTestCases(reportDir)).toThrowError(
      new Error(`Не удалось разобрать JSON-файл отчёта: ${brokenPath}`)
    );
  });

  it('читает русский текст из JSON через readTestCases', () => {
    copyFixture('test-cases/skipped.json', path.join('data', 'test-cases', 'skipped.json'));

    const [result] = readTestCases(reportDir);

    expect(result.name).toContain('Отображение стилей');
    expect(result.statusMessage).toContain('Ждем фикса');
  });

  it('собирает все файлы с не-логическим retry в одной ошибке', () => {
    const dir = path.join(reportDir, 'data', 'test-cases');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'retry-string.json'),
      JSON.stringify({ ...fixture('passed'), retry: 'false' }),
      'utf8'
    );
    writeFileSync(
      path.join(dir, 'retry-number.json'),
      JSON.stringify({ ...fixture('skipped'), retry: 1 }),
      'utf8'
    );

    expect(() => readTestCases(reportDir)).toThrow(
      /retry-string\.json.*retry-number\.json|retry-number\.json.*retry-string\.json/
    );
  });
});

describe('Чтение сводки Allure', () => {
  it('читает сводку Allure', () => {
    copyFixture('summary.json', path.join('widgets', 'summary.json'));

    expect(readAllureSummary(reportDir).statistic.total).toBe(370);
  });

  it('даёт понятную ошибку на русском при отсутствующей сводке', () => {
    const missingFile = path.join(reportDir, 'widgets', 'summary.json');

    expect(() => readAllureSummary(reportDir)).toThrowError(
      new Error(`В кэше нет сводки отчёта: ${missingFile}`)
    );
  });

  it('называет повреждённый файл сводки в ошибке', () => {
    const brokenPath = path.join(reportDir, 'widgets', 'summary.json');
    mkdirSync(path.dirname(brokenPath), { recursive: true });
    writeFileSync(brokenPath, '{ broken', 'utf8');

    expect(() => readAllureSummary(reportDir)).toThrowError(
      new Error(`Не удалось разобрать JSON-файл отчёта: ${brokenPath}`)
    );
  });
});

describe('фикстуры отражают реальный прогон', () => {
  it('запись попытки помечена флагом retry', () => {
    expect(fixture('failed-retry').retry).toBe(true);
  });

  it('основная запись падения помечена как упавшая впервые', () => {
    expect(fixture('failed-main').newFailed).toBe(true);
  });

  it('основная запись падения содержит текст ошибки', () => {
    expect(fixture('failed-main').testStage?.statusMessage).toContain(
      'Element should not be visible'
    );
  });

  it('у пропущенного теста нет testStage', () => {
    expect(fixture('skipped').testStage).toBeUndefined();
  });

  it('русские названия читаются без искажения', () => {
    expect(fixture('failed-main').name).toMatch(/[А-Яа-я]/);
  });
});

describe('Чтение метки теста', () => {
  it('достаёт имя класса теста', () => {
    expect(labelOf(fixture('failed-main'), 'testClass')).toBe(
      'tests.SmokeTest'
    );
  });

  it('возвращает null для отсутствующей метки', () => {
    expect(labelOf(fixture('failed-main'), 'несуществующая')).toBeNull();
  });
});
