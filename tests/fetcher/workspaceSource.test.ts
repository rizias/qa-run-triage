import { resolveServer } from '../../src/serverResolution.js';
import { DEFAULT_ENVIRONMENT } from '../../src/configFields.js';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';
import { fetchRun } from '../../src/fetcher/fetchRun.js';
import { runDir, sourceArchiveFile } from '../../src/fetcher/cachePaths.js';
import type { Config } from '../../src/config.js';
import type { BuildMeta, CiClient } from '../../src/ci/client.js';
import { DEFAULT_SETTINGS } from '../../src/settings.js';

const JOB = 'backend/all-tests';

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

function writeSourceZip(file: string): void {
  const zip = new AdmZip();
  zip.addFile(
    'src/test/java/tests/SmokeTest.java',
    Buffer.from('class SmokeTest {}', 'utf8')
  );
  zip.writeZip(file);
}

class WorkspaceClient {
  readonly nodeArguments: Array<number | undefined> = [];
  readonly workspaceNodeMax = 40;

  constructor(private readonly zipFile: string) {}

  getBuildMeta(_job: string, build: number): Promise<BuildMeta> {
    if (build === 30) {
      return Promise.resolve(buildMeta(30, 'run-commit'));
    }
    if (build === 31) {
      return Promise.resolve(buildMeta(31, 'latest-commit'));
    }
    return Promise.reject(new Error(`неожиданный GET ${build}`));
  }

  getLatestCompletedBuildMeta(): Promise<BuildMeta | null> {
    return Promise.resolve(buildMeta(31, 'latest-commit'));
  }

  downloadConsoleLog(_job: string, _build: number, destFile: string): Promise<number> {
    writeFileSync(destFile, 'лог сборки', 'utf8');
    return Promise.resolve(Buffer.byteLength('лог сборки', 'utf8'));
  }

  findWorkspaceNode(
    _job: string,
    _build: number,
    preferredNode?: number
  ): Promise<number | null> {
    this.nodeArguments.push(preferredNode);
    return Promise.resolve(18);
  }

  downloadWorkspaceSource(
    _job: string,
    _build: number,
    _node: number,
    destFile: string
  ): Promise<number | null> {
    copyFileSync(this.zipFile, destFile);
    return Promise.resolve(statSync(destFile).size);
  }
}

function buildMeta(number: number, commit: string): BuildMeta {
  return {
    number,
    result: 'SUCCESS',
    timestamp: number,
    durationMs: 1,
    artifacts: [],
    parameters: {},
    commit
  };
}

describe('fetchRun — рабочий каталог Jenkins', () => {
  it('использует workspace fallback, сохраняет свежесть и кеширует node id', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'triage-workspace-'));
    const work = mkdtempSync(path.join(tmpdir(), 'triage-workspace-zip-'));
    try {
      const zipFile = path.join(work, 'src.zip');
      writeSourceZip(zipFile);
      const client = new WorkspaceClient(zipFile);

      const first = await fetchRun(
        client as unknown as CiClient,
        makeConfig(cache),
        JOB,
        30,
        REPORT_ARTIFACT,
        true
      );
      const second = await fetchRun(
        client as unknown as CiClient,
        makeConfig(cache),
        JOB,
        30,
        REPORT_ARTIFACT,
        true
      );
      const hash = createHash('sha256').update(readFileSync(zipFile)).digest('hex');
      const meta = JSON.parse(
        readFileSync(path.join(runDir(cache, JOB, 30), 'meta.json'), 'utf8')
      ) as { sourceFreshness: unknown; workspaceNode: number };
      expect(first.source).toEqual({ sha256: hash });
      expect(second.source).toEqual(first.source);
      expect(existsSync(sourceArchiveFile(cache, hash))).toBe(true);
      expect(meta.workspaceNode).toBe(18);
      expect(meta.sourceFreshness).toEqual({
        isCurrent: false,
        runCommit: 'run-commit',
        latestBuildCommit: 'latest-commit',
        warning: 'Показан код более нового прогона, коммита latest-commit, вместо кода разбираемого прогона run-commit.'
      });
      expect(client.nodeArguments).toEqual([undefined, 18]);
    } finally {
      rmSync(cache, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});
