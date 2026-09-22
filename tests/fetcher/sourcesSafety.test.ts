import { resolveServer } from '../../src/serverResolution.js';
import { DEFAULT_ENVIRONMENT } from '../../src/configFields.js';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { describe, expect, it, vi } from 'vitest';
import { readPreviousMeta } from '../../src/fetcher/fetchRunSteps.js';
import type { Config } from '../../src/config.js';
import {
  runDir,
  sourceHashDir
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

function writeSourceZipSlip(file: string): void {
  const zip = new AdmZip();
  zip.addFile(
    'src/test/java/tests/SmokeTest.java',
    Buffer.from('class SmokeTest {}', 'utf8')
  );
  const evilEntry = zip.addFile('src/placeholder.java', Buffer.from('bad', 'utf8'));
  evilEntry.entryName = 'src/../../evil.java';
  zip.writeZip(file);
}

describe('fetchRun — сохранность исходников в кэше', () => {
  it('не выпускает запись архива исходников за пределы hash-каталога', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'triage-source-fetch-'));
    const work = mkdtempSync(path.join(tmpdir(), 'triage-source-zip-'));
    try {
      const zipFile = path.join(work, 'src.zip');
      writeSourceZipSlip(zipFile);

      const manifest = await fetchRun(
        new ArtifactClient(zipFile, 30) as unknown as CiClient,
        makeConfig(cache),
        'backend/all-tests',
        30,
        REPORT_ARTIFACT,
        true
      );
      const hash = manifest.source!.sha256;

      expect(existsSync(path.join(sourceHashDir(cache, hash), 'evil.java'))).toBe(false);
      expect(existsSync(path.join(cache, 'evil.java'))).toBe(false);
      expect(manifest.missing.some((entry) => entry.reason.includes('zip slip'))).toBe(true);
    } finally {
      rmSync(cache, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('сохраняет старый каталог sources при обновлении кэша прогона', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'triage-source-fetch-'));
    try {
      const oldSource = path.join(runDir(cache, 'backend/all-tests', 30), 'sources', 'old.java');
      mkdirSync(path.dirname(oldSource), { recursive: true });
      writeFileSync(oldSource, 'old source', 'utf8');

      await fetchRun(
        new ArtifactClient(null, 30) as unknown as CiClient,
        makeConfig(cache),
        'backend/all-tests',
        30,
        REPORT_ARTIFACT,
        true
      );

      expect(readFileSync(oldSource, 'utf8')).toBe('old source');
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it('не удаляет старый каталог sources при очистке лишних прогонов', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'triage-source-fetch-'));
    try {
      for (let build = 100; build <= 120; build += 1) {
        mkdirSync(runDir(cache, 'backend/all-tests', build), { recursive: true });
      }
      const oldSource = path.join(runDir(cache, 'backend/all-tests', 1), 'sources', 'old.java');
      mkdirSync(path.dirname(oldSource), { recursive: true });
      writeFileSync(oldSource, 'old source', 'utf8');

      await fetchRun(
        new ArtifactClient(null, 121) as unknown as CiClient,
        makeConfig(cache),
        'backend/all-tests',
        121,
        REPORT_ARTIFACT,
        true
      );

      expect(readFileSync(oldSource, 'utf8')).toBe('old source');
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });
});

describe('Предыдущие метаданные прогона', () => {
  it('Битый meta.json при повторном fetch не притворяется отсутствием', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'triage-meta-'));
    try {
      writeFileSync(path.join(dir, 'meta.json'), '{не json', 'utf8');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect(readPreviousMeta(dir)).toBeNull();
      expect(warn.mock.calls.some((call) => String(call[0]).includes('meta.json'))).toBe(true);
      warn.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
