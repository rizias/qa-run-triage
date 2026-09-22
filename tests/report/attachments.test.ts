import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { collectAttachments } from '../../src/report/attachments.js';
import type { TestCase, TestStage } from '../../src/report/types.js';

const dir = path.join(process.cwd(), 'tests', 'fixtures', 'run-30', 'test-cases');

function fixture(name: string): TestCase {
  return JSON.parse(readFileSync(path.join(dir, `${name}.json`), 'utf8')) as TestCase;
}

function stage(name: string): TestStage {
  const found = fixture(name).testStage;
  if (!found) {
    throw new Error(`в фикстуре ${name} нет testStage`);
  }
  return found;
}

describe('Сбор вложений', () => {
  it('берёт вложения верхнего уровня', () => {
    const stage: TestStage = {
      attachments: [{ name: 'Cookies', source: 'a.html', type: 'text/html' }],
      steps: []
    };
    expect(collectAttachments(stage)).toHaveLength(1);
  });

  it('берёт вложения из вложенного шага', () => {
    const stage: TestStage = {
      attachments: [],
      steps: [
        {
          name: 'шаг',
          steps: [
            {
              name: 'вложенный шаг',
              attachments: [{ name: 'скриншот', source: 'b.png', type: 'image/png' }]
            }
          ]
        }
      ]
    };
    const result = collectAttachments(stage);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('b.png');
  });

  it('не теряет вложения при обходе реального упавшего теста', () => {
    const all = collectAttachments(stage('failed-main'));
    expect(all).toEqual([
      { uid: 'пример-134', name: 'Проверка примера', source: 'пример-135.txt', type: 'text/csv', size: 462 },
      { uid: 'пример-136', name: 'Проверка примера', source: 'пример-137.bin', type: 'text/plain', size: 0 },
      { uid: 'пример-138', name: 'Проверка примера', source: 'пример-139.html', type: 'text/html', size: 3084 },
      { uid: 'пример-140', name: 'Проверка примера', source: 'пример-141.html', type: 'text/html', size: 4137 },
      { uid: 'пример-142', name: 'Проверка примера', source: 'пример-143.txt', type: 'text/csv', size: 814 },
      { uid: 'пример-108', name: 'Проверка примера', source: 'пример-109.txt', type: 'text/plain', size: 685 },
      { uid: 'пример-110', name: 'Проверка примера', source: 'пример-111.txt', type: 'application/json', size: 4087 },
      { uid: 'пример-112', name: 'Проверка примера', source: 'пример-113.txt', type: 'text/plain', size: 664 },
      { uid: 'пример-114', name: 'Проверка примера', source: 'пример-115.txt', type: 'application/json', size: 7 },
      { uid: 'пример-116', name: 'Проверка примера', source: 'пример-117.txt', type: 'text/plain', size: 669 },
      { uid: 'пример-118', name: 'Проверка примера', source: 'пример-119.txt', type: 'application/json', size: 0 },
      { uid: 'пример-127', name: 'Проверка примера', source: 'пример-128.png', type: 'image/png', size: 109727 },
      { uid: 'пример-129', name: 'Проверка примера', source: 'пример-130.html', type: 'text/html', size: 90846 },
      { uid: 'пример-131', name: 'Проверка примера', source: 'пример-132.txt', type: 'application/json', size: 168512 }
    ]);
  });

  it('на верхнем уровне упавшего теста скриншота нет', () => {
    const top = stage('failed-main').attachments ?? [];
    expect(top.some((item) => item.source.endsWith('.png'))).toBe(false);
  });

  it('находит скриншот, приложенный внутри шага упавшего теста', () => {
    const all = collectAttachments(stage('failed-main'));
    expect(all.some((item) => item.source.endsWith('.png'))).toBe(true);
  });

  it('возвращает пустой список, когда вложений нет', () => {
    expect(collectAttachments({ steps: [], attachments: [] })).toEqual([]);
  });
});
