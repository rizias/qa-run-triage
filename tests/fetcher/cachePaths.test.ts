import { describe, it, expect } from 'vitest';
import {
  runDir,
  reportDir,
  sourceArchiveFile,
  sourceExtractedDir,
  sourceHashDir
} from '../../src/fetcher/cachePaths.js';
import { toCacheKey } from '../../src/fetcher/cachePaths.js';
import path from 'node:path';

describe('Каталог прогона', () => {
  it('строит каталог прогона из ключа джобы и номера', () => {
    const result = runDir('C:\\cache', 'backend/all-tests', 30);
    expect(result).toBe(path.join('C:\\cache', 'runs', toCacheKey('backend/all-tests'), '30'));
  });
});

describe('Каталог отчёта', () => {
  it('указывает на распакованный отчёт внутри каталога прогона', () => {
    const result = reportDir('C:\\cache', 'backend/all-tests', 30);
    expect(result).toBe(
      path.join('C:\\cache', 'runs', toCacheKey('backend/all-tests'), '30', 'report', 'allure-report')
    );
  });
});

describe('Каталог исходников по хэшу', () => {
  const sha256 = 'a'.repeat(64);

  it('строит общий каталог исходников по SHA-256', () => {
    expect(sourceHashDir('C:\\cache', sha256)).toBe(
      path.join('C:\\cache', 'sources-by-hash', sha256)
    );
    expect(sourceArchiveFile('C:\\cache', sha256)).toBe(
      path.join('C:\\cache', 'sources-by-hash', sha256, 'src.zip')
    );
    expect(sourceExtractedDir('C:\\cache', sha256)).toBe(
      path.join('C:\\cache', 'sources-by-hash', sha256, 'extracted')
    );
  });

  it('не принимает значение, способное выйти из каталога кэша', () => {
    expect(() => sourceHashDir('C:\\cache', '..')).toThrow('Некорректная SHA-256');
  });
});

describe('Ключ кэша джобы', () => {
  it('различает пути с разной вложенностью', () => {
    expect(toCacheKey('A/B_C')).not.toBe(toCacheKey('A_B/C'));
  });

  it('различает пути только регистром и безопасен для Windows', () => {
    const key = toCacheKey('A/CON.:*? B ');
    expect(key).toMatch(/^[^<>:"/\\|?*]+-[0-9a-f]{8}$/);
    expect(key).not.toBe(toCacheKey('a/con.:*? b '));
  });

  it('имя каталога читается человеком', () => {
    expect(toCacheKey('backend/all-tests')).toBe('backend_all-tests-e9f50258');
  });

  it('ключ байт-в-байт совпадает с алгоритмом коммита f55ad66 (регресс на реальном кэше)', () => {
    expect(toCacheKey('Playwright/TA-playwright-e2e')).toBe('Playwright_TA-playwright-e2e-5bf946bb');
  });

  it('регистр в имени джобы сохраняется в ключе кэша', () => {
    expect(toCacheKey('Backend/Smoke-Test')).toBe('Backend_Smoke-Test-2172a861');
    expect(toCacheKey('Backend/Smoke-Test')).not.toBe(toCacheKey('backend/smoke-test'));
  });
});
