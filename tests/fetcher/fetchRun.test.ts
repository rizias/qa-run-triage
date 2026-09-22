import { DEFAULT_ENVIRONMENT } from '../../src/configFields.js';
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, copyFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { fetchRun } from '../../src/fetcher/fetchRun.js';
import { runDir, reportDir, jobRunsDir } from '../../src/fetcher/cachePaths.js';
import { type Config, type ResolvedServer } from '../../src/config.js';
import { type BuildMeta, type CiClient } from '../../src/ci/client.js';
import { DEFAULT_SETTINGS } from '../../src/settings.js';
import { resolveServer } from '../../src/serverResolution.js';
import { COMMAND_HANDLERS } from '../../src/cli/commands.js';

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

function makeConfig(cacheDir: string, serverOverrides: Partial<ResolvedServer> = {}): Config {
  const server: ResolvedServer = {
    ...resolveServer('main', {}, undefined, {}),
    kind: 'jenkins',
    kindSource: 'file',
    baseUrl: 'http://example:8000',
    baseUrlSource: 'file',
    reportArtifact: 'allure-report.zip',
    reportArtifactSource: 'file',
    workspaceNodeMax: 40,
    workspaceNodeMaxSource: 'default',
    proxyUser: 'ci_reader',
    proxyUserSet: true,
    proxyUserSource: 'file',
    proxyPass: 'secret',
    proxyPassSet: true,
    proxyPassSource: 'file',
    ...serverOverrides
  };
  return {
    servers: { jenkins: server },
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
    private readonly logText: string = 'лог сборки',
    private readonly reportArtifactName: string = 'allure-report.zip'
  ) {}

  getBuildMeta(): Promise<BuildMeta> {
    return Promise.resolve(metaFromRaw(this.rawMeta));
  }

  getLatestCompletedBuildMeta(): Promise<BuildMeta | null> {
    return Promise.resolve(null);
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
    if (artifactPath === this.reportArtifactName) {
      if (!this.zipSource) {
        return Promise.reject(new Error('в этом сценарии архив недоступен'));
      }
      copyFileSync(this.zipSource, destFile);
      return Promise.resolve(statSync(destFile).size);
    }
    return Promise.reject(new Error(`неожиданный путь скачивания: ${artifactPath}`));
  }
}

const noNetworkClient = {
  getBuildMeta: () => Promise.reject(new Error('сеть не должна вызываться')),
  downloadConsoleLog: () => Promise.reject(new Error('сеть не должна вызываться')),
  downloadArtifact: () => Promise.reject(new Error('сеть не должна вызываться'))
} as unknown as CiClient;

function metaFromRaw(raw: unknown): BuildMeta {
  const record = raw as {
    number: number;
    result?: string;
    timestamp?: number;
    duration?: number;
    artifacts?: { relativePath: string }[];
  };
  return {
    number: record.number,
    result: record.result ?? null,
    timestamp: record.timestamp ?? 0,
    durationMs: record.duration ?? 0,
    artifacts: (record.artifacts ?? []).map((artifact) => artifact.relativePath),
    parameters: {},
    commit: null
  };
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

describe('fetchRun — кэш-хит', () => {
  it('при существующем манифесте и force=false не ходит в сеть', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'triage-fetch-'));
    try {
      const config = makeConfig(cache);
      const dir = runDir(cache, 'backend/all-tests', 27);
      mkdirSync(dir, { recursive: true });
      const cachedManifest = {
        job: 'backend/all-tests',
        build: 27,
        fetchedAt: '2026-01-01T00:00:00.000Z',
        files: [{ name: 'meta.json', bytes: 10 }],
        missing: [],
        source: null
      };
      writeFileSync(
        path.join(dir, 'manifest.json'),
        JSON.stringify(cachedManifest),
        'utf8'
      );

      const result = await fetchRun(
        noNetworkClient,
        config,
        'backend/all-tests',
        27,
        'allure-report.zip',
        false
      );

      expect(result).toEqual(cachedManifest);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it('перекачивает кэш, если манифест принадлежит другой джобе или билду', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'triage-fetch-'));
    try {
      const config = makeConfig(cache);
      const dir = runDir(cache, 'backend/all-tests', 27);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, 'manifest.json'),
        JSON.stringify({
          job: 'A/Other',
          build: 99,
          fetchedAt: 'чужой кэш',
          files: [],
          missing: [],
          source: null
        }),
        'utf8'
      );
      const client = new FakeJenkinsClient(rawMeta(27, []), null) as unknown as CiClient;

      const result = await fetchRun(client, config, 'backend/all-tests', 27, 'allure-report.zip', false);

      expect(result.job).toBe('backend/all-tests');
      expect(result.build).toBe(27);
      expect(result.fetchedAt).not.toBe('чужой кэш');
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });
});

describe('Принудительное скачивание прогона', () => {
  it('перекачивает прогон и не оставляет файлы прошлой версии', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'triage-fetch-'));
    const work = mkdtempSync(path.join(tmpdir(), 'triage-fetch-zip-'));
    try {
      const config = makeConfig(cache);
      const dir = runDir(cache, 'backend/all-tests', 27);
      const staleFile = path.join(
        reportDir(cache, 'backend/all-tests', 27),
        'widgets',
        'stale.json'
      );
      mkdirSync(path.dirname(staleFile), { recursive: true });
      writeFileSync(staleFile, '{"stale":true}', 'utf8');
      writeFileSync(
        path.join(dir, 'manifest.json'),
        JSON.stringify({
          job: 'backend/all-tests',
          build: 27,
          fetchedAt: 'старое значение',
          files: [],
          missing: [],
          source: null
        }),
        'utf8'
      );

      const zipFile = path.join(work, 'allure-report.zip');
      buildZip(
        [{ name: 'allure-report/widgets/behaviors.json', content: '{}' }],
        zipFile
      );
      const client = new FakeJenkinsClient(
        rawMeta(27, ['allure-report.zip']),
        zipFile
      ) as unknown as CiClient;

      const manifest = await fetchRun(client, config, 'backend/all-tests', 27, 'allure-report.zip', true);

      expect(manifest.fetchedAt).not.toBe('старое значение');
      expect(existsSync(staleFile)).toBe(false);
      expect(
        existsSync(
          path.join(reportDir(cache, 'backend/all-tests', 27), 'widgets', 'behaviors.json')
        )
      ).toBe(true);
    } finally {
      rmSync(cache, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('при сбое переименования сохраняет старый прогон и его манифест', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'triage-fetch-'));
    const work = mkdtempSync(path.join(tmpdir(), 'triage-fetch-zip-'));
    try {
      const config = makeConfig(cache);
      const dir = runDir(cache, 'backend/all-tests', 27);
      const oldManifest = {
        job: 'backend/all-tests',
        build: 27,
        fetchedAt: 'старое значение',
        files: [{ name: 'meta.json', bytes: 10 }],
        missing: [],
        source: null
      };
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(oldManifest), 'utf8');

      const zipFile = path.join(work, 'allure-report.zip');
      buildZip(
        [{ name: 'allure-report/widgets/behaviors.json', content: '{}' }],
        zipFile
      );
      const client = new FakeJenkinsClient(
        rawMeta(27, ['allure-report.zip']),
        zipFile
      ) as unknown as CiClient;
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      const rename = vi.mocked((await import('node:fs')).renameSync);
      rename.mockImplementation((source, destination) => {
        if (String(source).includes('.tmp-')) {
          throw new Error('переименование временного каталога не удалось');
        }
        return actual.renameSync(source, destination);
      });

      await expect(fetchRun(client, config, 'backend/all-tests', 27, 'allure-report.zip', true)).rejects.toThrow(
        'переименование временного каталога не удалось'
      );
      expect(JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))).toEqual(
        oldManifest
      );
    } finally {
      rmSync(cache, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('fetchRun — настроенное имя артефакта отчёта', () => {
  it('скачивает отчёт под именем из jenkins.reportArtifact', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'triage-fetch-'));
    const work = mkdtempSync(path.join(tmpdir(), 'triage-fetch-zip-'));
    try {
      const config = makeConfig(cache, { reportArtifact: 'report.zip' });
      const zipFile = path.join(work, 'report.zip');
      buildZip([{ name: 'allure-report/widgets/behaviors.json', content: '{}' }], zipFile);
      const client = new FakeJenkinsClient(
        rawMeta(27, ['report.zip']),
        zipFile,
        'лог сборки',
        'report.zip'
      ) as unknown as CiClient;

      const manifest = await fetchRun(client, config, 'backend/all-tests', 27, 'report.zip', true);

      expect(manifest.files).toContainEqual(expect.objectContaining({ name: 'downloads/report.zip' }));
      expect(manifest.missing).not.toContainEqual(
        expect.objectContaining({ name: 'report.zip' })
      );
      expect(
        existsSync(path.join(reportDir(cache, 'backend/all-tests', 27), 'widgets', 'behaviors.json'))
      ).toBe(true);
    } finally {
      rmSync(cache, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('артефакт с именем console.log не подменяет консольный лог и манифест без дублей', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'triage-fetch-'));
    const work = mkdtempSync(path.join(tmpdir(), 'triage-fetch-zip-'));
    try {
      const config = makeConfig(cache, { reportArtifact: 'console.log' });
      const zipFile = path.join(work, 'console.log');
      buildZip([{ name: 'allure-report/widgets/behaviors.json', content: '{}' }], zipFile);
      const client = new FakeJenkinsClient(
        rawMeta(31, ['console.log']),
        zipFile,
        'настоящий лог сборки',
        'console.log'
      ) as unknown as CiClient;

      const manifest = await fetchRun(client, config, 'backend/all-tests', 31, 'console.log', true);

      const consoleLogFile = path.join(runDir(cache, 'backend/all-tests', 31), 'console.log');
      expect(readFileSync(consoleLogFile, 'utf8')).toBe('настоящий лог сборки');
      expect(manifest.files).toContainEqual(expect.objectContaining({ name: 'downloads/report.zip' }));
      const names = manifest.files.map((file) => file.name);
      expect(new Set(names).size).toBe(names.length);
    } finally {
      rmSync(cache, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('fetchRun — отсутствие артефакта отчёта', () => {
  it('даёт запись в missing, а не исключение', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'triage-fetch-'));
    try {
      const config = makeConfig(cache);
      const client = new FakeJenkinsClient(
        rawMeta(5, []),
        null
      ) as unknown as CiClient;

      const manifest = await fetchRun(client, config, 'backend/all-tests', 5, 'allure-report.zip', true);

      expect(manifest.missing).toContainEqual({
        name: 'src.zip',
        reason: 'Рабочий каталог прогона недоступен: сетевая ошибка: client.findWorkspaceNode is not a function'
      });

      expect(manifest.missing).toEqual(expect.arrayContaining([
        {
          name: 'allure-report.zip',
          reason: 'Прогон завершился до создания отчёта'
        }
      ]));
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });
});


describe('Сервер и срок хранения кэша', () => {
  function client(): CiClient {
    return {
      getBuildMeta: vi.fn().mockResolvedValue({ artifacts: [], parameters: {}, commit: null }),
      downloadConsoleLog: vi.fn().mockImplementation((_job: string, _build: number, file: string) => {
        writeFileSync(file, 'лог');
        return Promise.resolve(3);
      }),
      getLatestCompletedBuildMeta: vi.fn().mockResolvedValue(null)
    } as unknown as CiClient;
  }

  function config(server = 'first'): Config {
    return {
      servers: { [server]: resolveServer(server, { baseUrl: 'https://ci.example' }, undefined, {}) },
      defaultServer: server, cacheDir: cache, repos: [], environment: DEFAULT_ENVIRONMENT,
      settings: { ...DEFAULT_SETTINGS, cacheKeepRuns: 2 }, profileName: 'default',
      profileSource: 'default', description: '', profileFile: path.join(cache, 'profile.json'),
      credentialsFile: path.join(cache, 'credentials.json'), profileFileFound: true
    };
  }

  const job = 'folder/example-job';

  let cache: string;

  beforeEach(() => { cache = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-cache-')); });
  afterEach(() => { vi.restoreAllMocks(); rmSync(cache, { recursive: true, force: true }); });

  it('смена сервера требует fetch во всех командах чтения и перекачивает прогон', async () => {
    const ci = client();
    const getBuildMeta = vi.spyOn(ci, 'getBuildMeta');
    const first = await fetchRun(ci, config(), job, 42, 'allure-report.zip');
    expect(first.server).toBe('first');
    for (const kind of ['summary', 'failures', 'source'] as const) {
      const command = kind === 'source'
        ? { kind, job, build: 42, testClass: 'tests.ExampleTest' } as const
        : kind === 'failures' ? { kind, job, build: 42, include: 'failed' } as const
          : { kind, job, build: 42 } as const;
      await expect(async () => COMMAND_HANDLERS[kind](config('second'), command)).rejects.toThrow('fetch');
    }
    const second = await fetchRun(ci, config('second'), job, 42, 'allure-report.zip');
    expect(second.server).toBe('second');
    expect(getBuildMeta).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(path.join(runDir(cache, job, 42), 'manifest.json'), 'utf8')))
      .toHaveProperty('server', 'second');
  });

  it.each([
    { build: 1, remaining: ['1', '5', '99'] },
    { build: 5, remaining: ['4', '5', '99'] }
  ])('fetch билда $build сохраняет его в пределе двух обычных прогонов и не трогает sources', async ({ build, remaining }) => {
    mkdirSync(path.join(runDir(cache, job, 99), 'sources'), { recursive: true });
    const seedConfig = config();
    seedConfig.settings.cacheKeepRuns = 5;
    for (const number of [1, 2, 3, 4, 5]) {
      await fetchRun(client(), seedConfig, job, number, 'allure-report.zip');
    }
    await fetchRun(client(), config(), job, build, 'allure-report.zip');
    expect(readdirSync(jobRunsDir(cache, job)).sort()).toEqual(remaining);
  });
});
