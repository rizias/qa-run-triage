import { resolveServer } from '../../src/serverResolution.js';
import { DEFAULT_ENVIRONMENT } from '../../src/configFields.js';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import {
  runDir,
  sourceArchiveFile,
  sourceExtractedDir,
  sourceHashDir,
  sourcesByHashDir
} from '../../src/fetcher/cachePaths.js';
import { fetchRun } from '../../src/fetcher/fetchRun.js';
import type { BuildMeta, CiClient } from '../../src/ci/client.js';
import { DEFAULT_SETTINGS } from '../../src/settings.js';

const REPORT_ARTIFACT = 'allure-report.zip';

function makeConfig(cacheDir: string): Config {
  return {
    servers: {
      jenkins: {
        ...resolveServer('main', {}, undefined, {}),
        kind: 'jenkins',
        kindSource: 'file',
        baseUrl: 'http://example:8000',
        baseUrlSource: 'file',
        reportArtifact: REPORT_ARTIFACT,
        reportArtifactSource: 'file',
        workspaceNodeMax: 40,
        workspaceNodeMaxSource: 'default',
        proxyUser: 'ci_reader',
        proxyUserSet: true,
        proxyUserSource: 'file',
        proxyPass: 'secret',
        proxyPassSet: true,
        proxyPassSource: 'file'
      }
    },
    cacheDir,
    defaultServer: 'jenkins',
    repos: [],
    environment: DEFAULT_ENVIRONMENT,
    allowedJobs: [],
    settings: { ...DEFAULT_SETTINGS },
    profileName: 'default',
    profileSource: 'default',
    description: '',
    profileFile: path.join(cacheDir, '..', 'profile.json'),
    profileFileFound: true,
    credentialsFile: path.join(cacheDir, '..', 'credentials.json')
  };
}

class ArtifactClient {
  sourceDownloads = 0;

  constructor(
    private readonly zipFile: string | null,
    private readonly build: number,
    private readonly fingerprint: string | null = null
  ) {}

  getBuildMeta(): Promise<BuildMeta> {
    return Promise.resolve({
      number: this.build,
      result: 'SUCCESS',
      timestamp: 1,
      durationMs: 1,
      artifacts: this.zipFile ? ['src/test/java/tests/SmokeTest.java'] : [],
      parameters: {},
      commit: null,
      sourceArchiveSha256: this.fingerprint
    });
  }

  getLatestCompletedBuildMeta(): Promise<BuildMeta | null> {
    return Promise.resolve(null);
  }

  downloadConsoleLog(_job: string, _build: number, destFile: string): Promise<number> {
    writeFileSync(destFile, 'лог сборки', 'utf8');
    return Promise.resolve(Buffer.byteLength('лог сборки', 'utf8'));
  }

  downloadArtifact(
    _job: string,
    _build: number,
    artifactPath: string,
    destFile: string
  ): Promise<number> {
    if (artifactPath === 'src/*zip*/src.zip' && this.zipFile) {
      this.sourceDownloads += 1;
      copyFileSync(this.zipFile, destFile);
      return Promise.resolve(statSync(destFile).size);
    }
    return Promise.reject(new Error(`неожиданный путь скачивания: ${artifactPath}`));
  }
}

function writeSourceZip(file: string): void {
  const zip = new AdmZip();
  zip.addFile(
    'src/test/java/tests/SmokeTest.java',
    Buffer.from('class SmokeTest {}', 'utf8')
  );
  zip.addFile('README.md', Buffer.from('не исходник', 'utf8'));
  zip.writeZip(file);
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

describe('fetchRun — архив исходников', () => {
  it('скачивает архив, считает SHA-256 и распаковывает только src/ в общий кэш', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'triage-source-fetch-'));
    const work = mkdtempSync(path.join(tmpdir(), 'triage-source-zip-'));
    try {
      const zipFile = path.join(work, 'src.zip');
      writeSourceZip(zipFile);
      const hash = sha256(zipFile);
      const client = new ArtifactClient(zipFile, 30) as unknown as CiClient;

      const manifest = await fetchRun(client, makeConfig(cache), 'backend/all-tests', 30, REPORT_ARTIFACT, true);

      expect(manifest.source).toEqual({ sha256: hash });
      expect(existsSync(sourceArchiveFile(cache, hash))).toBe(true);
      expect(readFileSync(
        path.join(sourceExtractedDir(cache, hash), 'src', 'test', 'java', 'tests', 'SmokeTest.java'),
        'utf8'
      )).toBe('class SmokeTest {}');
      const savedMeta = JSON.parse(
        readFileSync(path.join(runDir(cache, 'backend/all-tests', 30), 'meta.json'), 'utf8')
      ) as { sourceFreshness: unknown };
      expect(savedMeta.sourceFreshness).toMatchObject({ isCurrent: true, warning: null });
      expect(existsSync(path.join(sourceExtractedDir(cache, hash), 'README.md'))).toBe(false);
      expect(existsSync(path.join(runDir(cache, 'backend/all-tests', 30), 'sources'))).toBe(false);
    } finally {
      rmSync(cache, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('хранит одну копию и одну распаковку одинакового архива для разных прогонов', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'triage-source-fetch-'));
    const work = mkdtempSync(path.join(tmpdir(), 'triage-source-zip-'));
    try {
      const zipFile = path.join(work, 'src.zip');
      writeSourceZip(zipFile);
      const first = new ArtifactClient(zipFile, 30);
      const second = new ArtifactClient(zipFile, 31);

      const firstManifest = await fetchRun(
        first as unknown as CiClient,
        makeConfig(cache),
        'backend/all-tests',
        30,
        REPORT_ARTIFACT,
        true
      );
      const secondManifest = await fetchRun(
        second as unknown as CiClient,
        makeConfig(cache),
        'backend/all-tests',
        31,
        REPORT_ARTIFACT,
        true
      );

      expect(secondManifest.source).toEqual(firstManifest.source);
      expect(first.sourceDownloads).toBe(1);
      expect(second.sourceDownloads).toBe(1);
      expect(readdirSync(sourcesByHashDir(cache))).toEqual([sha256(zipFile)]);
    } finally {
      rmSync(cache, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('не делает GET архива, если Jenkins заранее отдал известную SHA-256', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'triage-source-fetch-'));
    const work = mkdtempSync(path.join(tmpdir(), 'triage-source-zip-'));
    try {
      const zipFile = path.join(work, 'src.zip');
      writeSourceZip(zipFile);
      const hash = sha256(zipFile);
      await fetchRun(
        new ArtifactClient(zipFile, 30) as unknown as CiClient,
        makeConfig(cache),
        'backend/all-tests',
        30,
        REPORT_ARTIFACT,
        true
      );
      const cached = new ArtifactClient(zipFile, 31, hash);

      const manifest = await fetchRun(
        cached as unknown as CiClient,
        makeConfig(cache),
        'backend/all-tests',
        31,
        REPORT_ARTIFACT,
        true
      );

      expect(cached.sourceDownloads).toBe(0);
      expect(manifest.source).toEqual({ sha256: hash });
    } finally {
      rmSync(cache, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('публикует реальный размер распакованных файлов для старого кэша без метаданных', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'triage-source-fetch-'));
    const work = mkdtempSync(path.join(tmpdir(), 'triage-source-zip-'));
    try {
      const zipFile = path.join(work, 'src.zip');
      writeSourceZip(zipFile);
      const hash = sha256(zipFile);
      await fetchRun(
        new ArtifactClient(zipFile, 30) as unknown as CiClient,
        makeConfig(cache),
        'backend/all-tests',
        30,
        REPORT_ARTIFACT,
        true
      );
      unlinkSync(path.join(sourceHashDir(cache, hash), 'cache.json'));

      const manifest = await fetchRun(
        new ArtifactClient(zipFile, 31, hash) as unknown as CiClient,
        makeConfig(cache),
        'backend/all-tests',
        31,
        REPORT_ARTIFACT,
        true
      );
      const extracted = manifest.files.find((file) => file.name.endsWith('/extracted/'));

      expect(extracted?.bytes).toBe(Buffer.byteLength('class SmokeTest {}', 'utf8'));
    } finally {
      rmSync(cache, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('помечает отсутствие архива исходников без ошибки всего скачивания', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'triage-source-fetch-'));
    try {
      const manifest = await fetchRun(
        new ArtifactClient(null, 30) as unknown as CiClient,
        makeConfig(cache),
        'backend/all-tests',
        30,
        REPORT_ARTIFACT,
        true
      );

      expect(manifest.source).toBeNull();
      expect(manifest.missing).toContainEqual({
        name: 'src.zip',
        reason: 'Рабочий каталог прогона недоступен: сетевая ошибка: client.findWorkspaceNode is not a function'
      });
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });
});
