import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { listFailures } from '../../src/digest/failures.js';
import type { TestCase } from '../../src/report/types.js';

const dir = path.join(process.cwd(), 'tests', 'fixtures', 'run-30', 'test-cases');

function fixture(name: string): TestCase {
  return JSON.parse(readFileSync(path.join(dir, `${name}.json`), 'utf8')) as TestCase;
}

const cases = [
  fixture('failed-main'),
  fixture('failed-main-2'),
  fixture('failed-retry'),
  fixture('recovered'),
  fixture('passed'),
  fixture('skipped')
];

describe('listFailures с include=failed', () => {
  it('берёт только основную запись падения', () => {
    const result = listFailures(cases, 'failed');
    expect(result).toHaveLength(2);
  });

  it('заполняет класс и метод теста', () => {
    const [item] = listFailures(cases, 'failed');
    expect(item.testClass).toBe('tests.SmokeTest');
    expect(item.testMethod).toBe('smokeTest');
  });

  it('переносит текст ошибки', () => {
    const [item] = listFailures(cases, 'failed');
    expect(item.statusMessage).toContain('Element should not be visible');
  });

  it('сохраняет значения параметров', () => {
    const [item] = listFailures(cases, 'failed');
    expect(item.parameterValues.length).toBeGreaterThan(0);
  });

  it('переносит историю теста за прошлые прогоны', () => {
    const [item] = listFailures(cases, 'failed');
    expect(item.historyStatuses).toHaveLength(20);
  });

  it('переносит статусы трёх перезапусков из массива retries', () => {
    const [item] = listFailures([fixture('failed-main')], 'failed');
    expect(item.retryStatuses).toEqual(['failed', 'failed', 'failed']);
  });
});

describe('listFailures с include=recovered', () => {
  it('берёт тест, прошедший со второй попытки', () => {
    const result = listFailures(cases, 'recovered');
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe('passed');
  });

  it('не берёт тест, прошедший с первой попытки', () => {
    const result = listFailures([fixture('passed')], 'recovered');
    expect(result).toEqual([]);
  });
});

describe('сортировка', () => {
  it('ставит упавшие впервые в начало', () => {
    const known = { ...fixture('failed-main'), newFailed: false, uid: 'known' };
    const result = listFailures([known, fixture('failed-main')], 'failed');
    expect(result[0].newFailed).toBe(true);
  });
});

describe('корневой текст ошибки', () => {
  it('берёт statusMessage с корня записи без testStage', () => {
    const { testStage: _testStage, ...skipped } = fixture('skipped');
    const skippedWithoutStage = { ...skipped, status: 'failed' } as TestCase;

    const [item] = listFailures([skippedWithoutStage], 'failed');

    expect(item.statusMessage).toBe(fixture('skipped').statusMessage);
  });

  it('считает пустой statusMessage в testStage отсутствующим', () => {
    const original = fixture('failed-main');
    const emptyStage = { ...original.testStage, statusMessage: '' };
    const itemWithEmptyStage = { ...original, testStage: emptyStage } as TestCase;

    const [item] = listFailures([itemWithEmptyStage], 'failed');

    expect(item.statusMessage).toBe(original.statusMessage);
  });

  it('не сливает два падения одного теста с разными параметрами', () => {
    const result = listFailures(
      [fixture('failed-main'), fixture('failed-main-2')],
      'failed'
    );

    expect(result).toHaveLength(2);
    expect(result[0].parameterValues).not.toEqual(result[1].parameterValues);
  });
});

describe('тест Playwright', () => {
  it('падение несёт testFile и testLine из fullName, testClass и testMethod пусты', () => {
    const [item] = listFailures([fixture('playwright-failed')], 'failed');

    expect(item.testFile).toBe('packages/app/e2e/tests/login.test.ts');
    expect(item.testLine).toBeNull();
    expect(item.testClass).toBeNull();
    expect(item.testMethod).toBeNull();
  });

  it('восстановившийся после повтора тоже несёт testFile и testLine', () => {
    const result = listFailures([fixture('playwright-recovered')], 'recovered');

    expect(result).toHaveLength(1);
    expect(result[0].testFile).toBe('packages/app/e2e/tests/login.test.ts');
    expect(result[0].testLine).toBeNull();
  });

  it('у теста Java testFile и testLine пусты', () => {
    const [item] = listFailures([fixture('failed-main')], 'failed');

    expect(item.testFile).toBeNull();
    expect(item.testLine).toBeNull();
    expect(item.testClass).toBe('tests.SmokeTest');
  });
});

describe('точная подпись в списке падений', () => {
  it('сохраняет многострочный текст с регистром, токеном и пробелами байт-в-байт', () => {
    const signature = '  Token AbC-123\nSecond LINE  ';
    const original = fixture('failed-main');
    const testCase = {
      ...original,
      statusMessage: 'корневой текст',
      testStage: {
        ...original.testStage,
        statusMessage: signature,
        statusTrace: 'TRACE, который не входит в подпись'
      }
    } as TestCase;

    const [item] = listFailures([testCase], 'failed');

    expect(Buffer.from(item.fingerprint, 'utf8')).toEqual(Buffer.from(signature, 'utf8'));
    expect(item.statusMessage).toBe(signature);
    expect(item.statusTrace).toBe('TRACE, который не входит в подпись');
  });

  it('использует точный корневой statusMessage, когда сообщение testStage пусто', () => {
    const signature = 'Root Token-X9\n  next line ';
    const original = fixture('failed-main');
    const testCase = {
      ...original,
      statusMessage: signature,
      testStage: { ...original.testStage, statusMessage: '' }
    } as TestCase;

    const [item] = listFailures([testCase], 'failed');

    expect(item.fingerprint).toBe(signature);
  });

  it('возвращает пустую подпись, когда оба сообщения пусты', () => {
    const original = fixture('failed-main');
    const testCase = {
      ...original,
      statusMessage: '',
      testStage: { ...original.testStage, statusMessage: '' }
    } as TestCase;

    const [item] = listFailures([testCase], 'failed');

    expect(item.fingerprint).toBe('');
  });
});
