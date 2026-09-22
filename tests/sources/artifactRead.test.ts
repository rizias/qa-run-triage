import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runDir, sourceExtractedDir } from '../../src/fetcher/cachePaths.js';
import { readTestSource, resolveInsideSourceRoot } from '../../src/sources/artifactRead.js';

const JOB = 'backend/all-tests';
const BUILD = 30;
const SHA256 = 'a'.repeat(64);

function writeManifest(cacheDir: string, source: { sha256: string } | null): void {
  const dir = runDir(cacheDir, JOB, BUILD);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ source }), 'utf8');
}

function writeSource(cacheDir: string, sourcePath: string, text: string): void {
  const file = path.join(sourceExtractedDir(cacheDir, SHA256), ...sourcePath.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

describe('Чтение исходника из архива', () => {
  it.each([
    'src/main/java/tests/SmokeTest.java',
    'src/test/java/tests/SmokeTest.java'
  ])('читает класс из кэша по пути %s', async (sourcePath) => {
    const cache = mkdtempSync(path.join(tmpdir(), 'triage-source-'));
    try {
      writeManifest(cache, { sha256: SHA256 });
      writeSource(cache, sourcePath, 'class SmokeTest {}');

      await expect(readTestSource(cache, JOB, BUILD, 'tests.SmokeTest')).resolves.toEqual({
        path: sourcePath,
        text: 'class SmokeTest {}',
        freshness: {
          isCurrent: null,
          runCommit: null,
          latestBuildCommit: null,
          warning: null
        }
      });
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it('возвращает ошибку с обоими путями при двойном совпадении', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'triage-source-'));
    try {
      writeManifest(cache, { sha256: SHA256 });
      writeSource(cache, 'src/main/java/tests/SmokeTest.java', 'main');
      writeSource(cache, 'src/test/java/tests/SmokeTest.java', 'test');

      await expect(readTestSource(cache, JOB, BUILD, 'tests.SmokeTest')).rejects.toThrow(
        'src/main/java/tests/SmokeTest.java, src/test/java/tests/SmokeTest.java'
      );
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it('объясняет отсутствие архива и не читает старый каталог прогона', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'triage-source-'));
    try {
      writeManifest(cache, null);
      const oldFile = path.join(
        runDir(cache, JOB, BUILD),
        'sources',
        'src',
        'test',
        'java',
        'tests',
        'SmokeTest.java'
      );
      mkdirSync(path.dirname(oldFile), { recursive: true });
      writeFileSync(oldFile, 'old source', 'utf8');

      await expect(readTestSource(cache, JOB, BUILD, 'tests.SmokeTest')).rejects.toThrow(
        'исходники не архивировались, разбор возможен без них'
      );
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it('перечисляет оба проверенных пути, если класс не найден', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'triage-source-'));
    try {
      writeManifest(cache, { sha256: SHA256 });

      await expect(readTestSource(cache, JOB, BUILD, 'tests.SmokeTest')).rejects.toThrow(
        'src/main/java/tests/SmokeTest.java, src/test/java/tests/SmokeTest.java'
      );
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });
});

describe('readTestSource — граница доступа', () => {
  it('отказывает в джобе вне списка до чтения кэша', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'triage-source-access-'));
    try {
      await expect(
        readTestSource(cacheDir, 'backend/other', 1, 'tests.SmokeTest', ['backend/smoke'])
      ).rejects.toThrow(/allowedJobs/);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it('пропускает джобу из списка', async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'triage-source-access-'));
    try {
      await expect(
        readTestSource(cacheDir, 'backend/smoke', 1, 'tests.SmokeTest', ['backend/smoke'])
      ).rejects.toThrow(/не архивировались/);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});

describe('битый JSON прогона', () => {
  it('Битый JSON манифеста и meta называет путь файла', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'triage-source-json-'));
    try {
      const dir = runDir(cache, JOB, BUILD);
      mkdirSync(dir, { recursive: true });
      const manifestFile = path.join(dir, 'manifest.json');
      writeFileSync(manifestFile, '{не json', 'utf8');
      await expect(readTestSource(cache, JOB, BUILD, 'tests.SmokeTest')).rejects.toSatisfy(
        (error: unknown) => error instanceof Error && error.message.includes(manifestFile)
      );
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });
});


describe('Граница каталога исходников', () => {
  it('Итоговый путь вне корня исходников не читается', () => {
      const root = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-rf-root-'));
      try {
        expect(() => resolveInsideSourceRoot(root, '..')).toThrow(/выходит за каталог исходников/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
});
