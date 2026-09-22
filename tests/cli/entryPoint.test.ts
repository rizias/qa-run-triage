import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isEntryPoint } from '../../src/cli/entryPoint.js';

const moduleFile = path.resolve('dist', 'cli', 'index.js');
const moduleUrl = pathToFileURL(moduleFile).href;

describe('Определение точки запуска', () => {
  it('истина, когда запущен сам файл модуля', () => {
    expect(isEntryPoint(moduleUrl, moduleFile)).toBe(true);
  });

  it('истина при относительном пути и обратных слэшах к тому же файлу', () => {
    const relative = path.relative(process.cwd(), moduleFile).split('/').join(path.sep);
    expect(isEntryPoint(moduleUrl, relative)).toBe(true);
  });

  it('ложь для другого файла, даже если в его пути есть слово cli', () => {
    expect(isEntryPoint(moduleUrl, path.resolve('tools', 'cli', 'other.js'))).toBe(false);
    expect(isEntryPoint(moduleUrl, path.resolve('some-cli-project', 'vitest.js'))).toBe(false);
  });

  it('ложь, когда запущенный файл неизвестен', () => {
    expect(isEntryPoint(moduleUrl, undefined)).toBe(false);
  });

  it('истина, когда запущенный путь ведёт к модулю через ссылку на каталог', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'entry-point-'));
    try {
      const real = path.join(root, 'real');
      mkdirSync(real);
      const file = path.join(real, 'index.js');
      writeFileSync(file, '');
      const link = path.join(root, 'link');
      symlinkSync(real, link, 'junction');
      const realUrl = pathToFileURL(realpathSync.native(file)).href;
      expect(isEntryPoint(realUrl, path.join(link, 'index.js'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
