import { resolveServer } from '../../src/serverResolution.js';
import { DEFAULT_ENVIRONMENT } from '../../src/configFields.js';
import { afterEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { fetchRun } from '../../src/fetcher/fetchRun.js';
import { runDir, reportDir } from '../../src/fetcher/cachePaths.js';
import { type Config } from '../../src/config.js';
import { type BuildMeta, type CiClient } from '../../src/ci/client.js';
import { DEFAULT_SETTINGS } from '../../src/settings.js';

const REPORT_ARTIFACT = 'allure-report.zip';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    renameSync: vi.fn(actual.renameSync)
  };
});

afterEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  vi.mocked(fs.renameSync).mockReset();
  vi.mocked(fs.renameSync).mockImplementation(actual.renameSync);
});

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

class FakeJenkinsClient {
  constructor(
    private readonly rawMeta: unknown,
    private readonly zipSource: string | null,
    private readonly logText: string = 'лог сборки'
  ) {}

  getBuildMeta(): Promise<BuildMeta> {
    const record = this.rawMeta as {
      number: number;
      result?: string;
      timestamp?: number;
      duration?: number;
      artifacts?: { relativePath: string }[];
    };
    return Promise.resolve({
      number: record.number,
      result: record.result ?? null,
      timestamp: record.timestamp ?? 0,
      durationMs: record.duration ?? 0,
      artifacts: (record.artifacts ?? []).map((artifact) => artifact.relativePath),
      parameters: {},
      commit: null
    });
  }

  downloadConsoleLog(_job: string, _build: number, destFile: string): Promise<number> {
    writeFileSync(destFile, this.logText, 'utf8');
    return Promise.resolve(Buffer.byteLength(this.logText, 'utf8'));
  }

  downloadArtifact(
    _job: string,
    _build: number,
    artifactPath: string,
    destFile: string
  ): Promise<number> {
    if (artifactPath === 'allure-report.zip') {
      if (!this.zipSource) {
        return Promise.reject(new Error('в этом сценарии архив недоступен'));
      }
      copyFileSync(this.zipSource, destFile);
      return Promise.resolve(statSync(destFile).size);
    }
    return Promise.reject(new Error(`неожиданный путь скачивания: ${artifactPath}`));
  }
}

function rawMeta(build: number, artifacts: string[]): unknown {
  return {
    number: build,
    result: 'SUCCESS',
    timestamp: 1,
    duration: 1,
    artifacts: artifacts.map((relativePath) => ({ relativePath })),
    actions: []
  };
}

function buildZip(entries: { name: string; content: string }[], destFile: string): void {
  const zip = new AdmZip();
  for (const entry of entries) {
    zip.addFile(entry.name, Buffer.from(entry.content, 'utf8'));
  }
  zip.writeZip(destFile);
}

function buildZipSlipFixture(destFile: string): void {
  const zip = new AdmZip();
  zip.addFile('allure-report/widgets/behaviors.json', Buffer.from('{}', 'utf8'));
  const evilEntry = zip.addFile(
    'allure-report/widgets/placeholder.txt',
    Buffer.from('bad-payload', 'utf8')
  );
  evilEntry.entryName = 'allure-report/widgets/../../../evil.txt';
  zip.writeZip(destFile);
}

describe('fetchRun — фильтр архива', () => {
  it('распаковывает из архива только нужные префиксы', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'triage-fetch-'));
    const work = mkdtempSync(path.join(tmpdir(), 'triage-fetch-zip-'));
    try {
      const config = makeConfig(cache);
      const zipFile = path.join(work, 'allure-report.zip');
      buildZip(
        [
          { name: 'allure-report/widgets/behaviors.json', content: '{}' },
          { name: 'allure-report/index.html', content: '<html></html>' },
          { name: 'allure-report/app.js', content: 'console.log(1)' }
        ],
        zipFile
      );
      const client = new FakeJenkinsClient(
        rawMeta(8, ['allure-report.zip']),
        zipFile
      ) as unknown as CiClient;

      await fetchRun(client, config, 'backend/all-tests', 8, REPORT_ARTIFACT, true);

      const dir = reportDir(cache, 'backend/all-tests', 8);
      expect(existsSync(path.join(dir, 'widgets', 'behaviors.json'))).toBe(true);
      expect(existsSync(path.join(dir, 'index.html'))).toBe(false);
      expect(existsSync(path.join(dir, 'app.js'))).toBe(false);
    } finally {
      rmSync(cache, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('Пути архива за пределами каталога', () => {
  it('запись с путём наружу не попадает за пределы каталога отчёта', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'triage-fetch-'));
    const work = mkdtempSync(path.join(tmpdir(), 'triage-fetch-zip-'));
    try {
      const config = makeConfig(cache);
      const zipFile = path.join(work, 'allure-report.zip');
      buildZipSlipFixture(zipFile);
      const client = new FakeJenkinsClient(
        rawMeta(9, ['allure-report.zip']),
        zipFile
      ) as unknown as CiClient;

      const manifest = await fetchRun(client, config, 'backend/all-tests', 9, REPORT_ARTIFACT, true);

      const dir = runDir(cache, 'backend/all-tests', 9);
      expect(existsSync(path.join(dir, 'evil.txt'))).toBe(false);
      expect(existsSync(path.join(cache, 'evil.txt'))).toBe(false);
      expect(
        existsSync(path.join(reportDir(cache, 'backend/all-tests', 9), 'widgets', 'behaviors.json'))
      ).toBe(true);
      expect(manifest.missing.some((entry) => entry.reason.includes('zip slip'))).toBe(
        true
      );
    } finally {
      rmSync(cache, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('fetchRun — чистка кэша', () => {
  it('только что скачанный старый билд остаётся вместе с девятнадцатью самыми новыми', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'triage-fetch-'));
    try {
      const config = makeConfig(cache);
      const jobDir = path.dirname(runDir(cache, 'backend/all-tests', 1));
      for (let number = 100; number <= 120; number += 1) {
        mkdirSync(path.join(jobDir, String(number)), { recursive: true });
      }
      const client = new FakeJenkinsClient(
        rawMeta(1, []),
        null
      ) as unknown as CiClient;

      await fetchRun(client, config, 'backend/all-tests', 1, REPORT_ARTIFACT, true);

      expect(fs.readdirSync(jobDir).sort((left, right) => Number(left) - Number(right))).toEqual([
        '1', '102', '103', '104', '105', '106', '107', '108', '109', '110',
        '111', '112', '113', '114', '115', '116', '117', '118', '119', '120'
      ]);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });
});


describe('Предел распаковки отчёта', () => {
  class FakeJenkins {
    constructor(private readonly zipFile: string) {}
    getBuildMeta(): Promise<BuildMeta> {
      return Promise.resolve({
        number: 9,
        result: 'SUCCESS',
        timestamp: 1,
        durationMs: 1,
        artifacts: ['allure-report.zip'],
        parameters: {},
        commit: null
      });
    }
    downloadConsoleLog(_job: string, _build: number, destFile: string): Promise<number> {
      writeFileSync(destFile, 'лог', 'utf8');
      return Promise.resolve(3);
    }
    downloadArtifact(
      _job: string,
      _build: number,
      _artifactPath: string,
      destFile: string
    ): Promise<number> {
      copyFileSync(this.zipFile, destFile);
      return Promise.resolve(statSync(destFile).size);
    }
  }

  function sourceConfig(cacheDir: string): Config {
    return {
      servers: {
        jenkins: {
          ...resolveServer('main', {}, undefined, {}),
          kind: 'jenkins',
          kindSource: 'file',
          baseUrl: 'https://jenkins.example',
          baseUrlSource: 'file',
          reportArtifact: 'allure-report.zip',
          reportArtifactSource: 'file',
          workspaceNodeMax: 40,
          workspaceNodeMaxSource: 'default',
          proxyUser: 'reader-example',
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
      settings: { ...DEFAULT_SETTINGS, archiveMaxBytes: 40 },
      profileName: 'default',
      profileSource: 'default',
      description: '',
      profileFile: path.join(cacheDir, '..', 'profile.json'),
      profileFileFound: true,
      credentialsFile: path.join(cacheDir, '..', 'credentials.json')
    };
  }

  it('Архив больше предела не распаковывается', async () => {
      const cache = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-rf4-fetch-'));
      const work = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-rf4-zip-'));
      try {
        const zipFile = path.join(work, 'allure-report.zip');
        const zip = new AdmZip();
        zip.addFile('allure-report/widgets/behaviors.json', Buffer.alloc(80, 123));
        zip.writeZip(zipFile);
        const client = new FakeJenkins(zipFile) as unknown as CiClient;
        await expect(
          fetchRun(client, sourceConfig(cache), 'folder/example-job', 9, 'allure-report.zip', true)
        ).rejects.toThrow(/allure-report\.zip[\s\S]*limits\.archiveMaxBytes[\s\S]*40/);
        expect(existsSync(runDir(cache, 'folder/example-job', 9))).toBe(false);
      } finally {
        rmSync(cache, { recursive: true, force: true });
        rmSync(work, { recursive: true, force: true });
      }
    });
});
