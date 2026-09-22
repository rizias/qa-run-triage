import { describe, it, expect } from 'vitest';
import { toSourcePaths } from '../../src/sources/testPath.js';

describe('Пути исходников по идентификатору', () => {
  it('строит пути класса в обоих корнях исходников', () => {
    expect(toSourcePaths('tests.pack.SmokeTest')).toEqual([
      'src/main/java/tests/pack/SmokeTest.java',
      'src/test/java/tests/pack/SmokeTest.java'
    ]);
  });

  it('обрабатывает короткий пакет', () => {
    expect(toSourcePaths('tests.SmokeTest')).toEqual([
      'src/main/java/tests/SmokeTest.java',
      'src/test/java/tests/SmokeTest.java'
    ]);
  });

  it('отбрасывает имя вложенного класса', () => {
    expect(toSourcePaths('tests.pack.SmokeTest$Inner')).toEqual([
      'src/main/java/tests/pack/SmokeTest.java',
      'src/test/java/tests/pack/SmokeTest.java'
    ]);
  });

  it('отвергает пустое имя класса', () => {
    expect(() => toSourcePaths('')).toThrow('Пустое имя класса');
  });

  it('путь с хвостом :строка:столбец отбрасывает хвост и даёт один кандидат', () => {
    expect(toSourcePaths('packages/app/e2e/tests/login.test.ts:12:5')).toEqual([
      'packages/app/e2e/tests/login.test.ts'
    ]);
  });

  it('путь без хвоста даёт один кандидат как есть', () => {
    expect(toSourcePaths('packages/app/e2e/tests/login.test.ts')).toEqual([
      'packages/app/e2e/tests/login.test.ts'
    ]);
  });

  it('Идентификатор с управляющим символом отвергается', () => {
    expect(() => toSourcePaths('foo/\0bar.ts')).toThrow(/управляющий символ/);
    expect(() => toSourcePaths('foo/\nbar.ts')).toThrow(/управляющий символ/);
  });

  it('Хвост строки и столбца снимается у имени класса', () => {
    expect(toSourcePaths('com.example.Test:12:5')).toEqual([
      'src/main/java/com/example/Test.java',
      'src/test/java/com/example/Test.java'
    ]);
  });
});


describe('Безопасность идентификатора исходников', () => {
  it('Идентификатор с выходом за каталог исходников отвергается', () => {
      expect(() => toSourcePaths('../../../../../../config.json')).toThrow(/\.\./);
      expect(() => toSourcePaths('C:\\Windows\\config.json')).toThrow(/обратный слэш|диска/);
      expect(() => toSourcePaths('/etc/passwd')).toThrow(/относительным/);
    });
});
