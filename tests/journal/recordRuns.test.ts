import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Config } from '../../src/config.js';
import { DEFAULT_ENVIRONMENT } from '../../src/configFields.js';
import { type ResolvedServer, resolveServer } from '../../src/serverResolution.js';
import { DEFAULT_SETTINGS } from '../../src/settings.js';
import { JenkinsClient, type JenkinsConnection } from '../../src/jenkins/client.js';
import { appendEntry, readEntries, type JournalEntryInput, normalizeEntry } from '../../src/journal/journal.js';
import { asRecordRunsResponse, recordRuns } from '../../src/journal/recordRuns.js';
import { type CiClient } from '../../src/ci/client.js';

let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-record-runs-'));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('Учёт прогонов', () => {
  it('записывает окружение зелёного прогона из параметров билда', async () => {
    const client = new JenkinsClient(connection(config()), ((url: string) => {
      if (url.includes('tree=number')) {
        return Promise.resolve(new Response(JSON.stringify({
          number: 7,
          result: 'SUCCESS',
          timestamp: 700,
          duration: 70,
          actions: [{
            parameters: [
              { name: 'env', value: 'stage' },
              { name: 'city', value: 'spb' },
              { name: 'code_branch', value: 'origin/main' }
            ]
          }]
        }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        builds: [{ number: 7, result: 'SUCCESS', timestamp: 700, duration: 70 }]
      }), { status: 200 }));
    }) as unknown as typeof fetch);

    await recordRuns(client, config(), 'jenkins', 'backend/all-tests');

    expect(readEntries(cacheDir).entries[0]).toMatchObject({
      env: 'stage',
      city: 'spb',
      codeBranch: 'origin/main'
    });
  });

  it('признак выполнения тестов берётся из наличия архива отчёта', async () => {
    const withReport = (artifacts: { relativePath: string }[]) =>
      new JenkinsClient(connection(config()), ((url: string) => {
        if (url.includes('tree=number')) {
          return Promise.resolve(new Response(JSON.stringify({
            number: 7,
            result: 'SUCCESS',
            timestamp: 700,
            duration: 70,
            artifacts,
            actions: [{ lastBuiltRevision: { SHA1: 'f'.repeat(40) } }]
          }), { status: 200 }));
        }
        return Promise.resolve(new Response(JSON.stringify({
          builds: [{ number: 7, result: 'SUCCESS', timestamp: 700, duration: 70 }]
        }), { status: 200 }));
      }) as unknown as typeof fetch);

    await recordRuns(withReport([{ relativePath: 'allure-report.zip' }]), config(), 'jenkins', 'backend/all-tests');
    expect(readEntries(cacheDir).entries[0].testsRan).toBe(true);
    expect(readEntries(cacheDir).entries[0].commit).toBe('f'.repeat(40));

    rmSync(cacheDir, { recursive: true, force: true });
    cacheDir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-record-runs-'));

    await recordRuns(withReport([{ relativePath: 'build.log' }]), config(), 'jenkins', 'backend/all-tests');
    expect(readEntries(cacheDir).entries[0].testsRan).toBe(false);
  });

  it('дозаполняет окружение у записи, сохранённой без него', async () => {
    appendEntry(cacheDir, entry({
      build: 7,
      result: 'SUCCESS',
      failed: 0,
      env: '',
      city: '',
      verdict: 'прогон зелёный'
    }));
    const client = new JenkinsClient(connection(config()), ((url: string) => {
      if (url.includes('tree=number')) {
        return new Response(JSON.stringify({
          number: 7,
          result: 'SUCCESS',
          timestamp: 700,
          duration: 70,
          actions: [{
            parameters: [
              { name: 'env', value: 'stage' },
              { name: 'city', value: 'spb' }
            ]
          }]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        builds: [{ number: 7, result: 'SUCCESS', timestamp: 700, duration: 70 }]
      }), { status: 200 });
    }) as unknown as typeof fetch);

    await recordRuns(client, config(), 'jenkins', 'backend/all-tests');

    const saved = readEntries(cacheDir).entries.find((item) => item.build === 7);
    expect(saved).toMatchObject({ env: 'stage', city: 'spb', verdict: 'прогон зелёный' });
  });

  it('не запрашивает параметры у записи, где окружение и город уже есть', async () => {
    appendEntry(cacheDir, entry({ build: 7, result: 'SUCCESS', failed: 0, env: 'stage', city: 'city-example' }));
    let metaRequests = 0;
    const client = new JenkinsClient(connection(config()), ((url: string) => {
      if (url.includes('tree=number')) {
        metaRequests += 1;
      }
      return new Response(JSON.stringify({
        builds: [{ number: 7, result: 'SUCCESS', timestamp: 700, duration: 70 }]
      }), { status: 200 });
    }) as unknown as typeof fetch);

    await recordRuns(client, config(), 'jenkins', 'backend/all-tests');

    expect(metaRequests).toBe(0);
  });

  it('не считает запись дозаполненной, когда среди параметров нет окружения', async () => {
    appendEntry(cacheDir, entry({ build: 7, result: 'SUCCESS', failed: 0, env: '' }));
    const client = new JenkinsClient(connection(config()), ((url: string) => {
      if (url.includes('tree=number')) {
        return new Response(JSON.stringify({
          number: 7,
          result: 'SUCCESS',
          timestamp: 700,
          duration: 70,
          actions: [{ parameters: [{ name: 'sendToTestOps', value: 'true' }] }]
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        builds: [{ number: 7, result: 'SUCCESS', timestamp: 700, duration: 70 }]
      }), { status: 200 });
    }) as unknown as typeof fetch);

    const result = await recordRuns(client, config(), 'jenkins', 'backend/all-tests');

    expect(result.filledEnv).toBe(0);
  });

  it('readMeta возвращает null только при отсутствии билда (404)', async () => {
    const missing = new JenkinsClient(connection(config()), ((url: string) => {
      if (url.includes('tree=number')) {
        return new Response('нет', { status: 404 });
      }
      return new Response(JSON.stringify({
        builds: [{ number: 7, result: 'SUCCESS', timestamp: 700, duration: 70 }]
      }), { status: 200 });
    }) as unknown as typeof fetch);

    await recordRuns(missing, config(), 'jenkins', 'backend/all-tests');
    expect(readEntries(cacheDir).entries[0]).toMatchObject({ env: '' });

    const failing = new JenkinsClient(connection(config()), ((url: string) => {
      if (url.includes('tree=number')) {
        return new Response('Ошибка', { status: 500 });
      }
      return new Response(JSON.stringify({
        builds: [{ number: 8, result: 'SUCCESS', timestamp: 800, duration: 80 }]
      }), { status: 200 });
    }) as unknown as typeof fetch);

    await expect(recordRuns(failing, config(), 'jenkins', 'backend/all-tests')).rejects.toThrow(/Jenkins ответил 500/);
  });

  it('добавляет отсутствующие SUCCESS и сохраняет разбор при дозаполнении сервера и адреса', async () => {
    appendEntry(cacheDir, entry({
      build: 5,
      result: 'FAILURE',
      failed: 1,
      verdict: 'красный прогон уже разобран',
      fingerprints: ['точная причина']
    }));
    appendEntry(cacheDir, entry({
      build: 4,
      result: 'SUCCESS',
      failed: 0,
      verdict: 'существующая зелёная запись'
    }));
    const before = readFileSync(path.join(cacheDir, 'journal.jsonl'), 'utf8');
    let requests = 0;
    const client = new JenkinsClient(connection(config()), () => {
      requests += 1;
      return Promise.resolve(new Response(JSON.stringify({
        builds: [
          { number: 6, result: 'SUCCESS', timestamp: 600, duration: 60 },
          { number: 5, result: 'SUCCESS', timestamp: 500, duration: 50 },
          { number: 4, result: 'SUCCESS', timestamp: 400, duration: 40 },
          { number: 3, result: 'FAILURE', timestamp: 300, duration: 30 },
          { number: 2, result: 'UNSTABLE', timestamp: 200, duration: 20 },
          { number: 1, result: 'ABORTED', timestamp: 100, duration: 10 },
          { number: 0, result: null, timestamp: 0, duration: 0 }
        ]
      }), { status: 200 }));
    });

    const first = await recordRuns(client, config(), 'jenkins', 'backend/all-tests');

    expect(first).toEqual({
      added: 1,
      filledEnv: 0,
      skippedAnalyzed: 0,
      needsReview: [
        { number: 3, result: 'FAILURE' },
        { number: 2, result: 'UNSTABLE' },
        { number: 1, result: 'ABORTED' },
        { number: 0, result: null }
      ]
    });
    expect(requests).toBe(4);
    const beforeLines = before.split('\n').filter((line) => line.length > 0);
    const afterLines = readFileSync(path.join(cacheDir, 'journal.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0);
    beforeLines.forEach((line, index) => {
      const previous = JSON.parse(line) as { build: number };
      expect(JSON.parse(afterLines[index])).toEqual({
        ...previous, server: 'jenkins',
        buildUrl: `https://jenkins.example/job/backend/job/all-tests/${previous.build}`
      });
    });

    const entries = readEntries(cacheDir).entries;
    expect(entries).toHaveLength(3);
    expect(entries.find((saved) => saved.build === 5)).toMatchObject({
      result: 'FAILURE',
      failed: 1,
      verdict: 'красный прогон уже разобран',
      fingerprints: ['точная причина']
    });
    expect(entries.find((saved) => saved.build === 4)).toMatchObject({
      result: 'SUCCESS',
      verdict: 'существующая зелёная запись'
    });
    expect(entries.find((saved) => saved.build === 6)).toMatchObject({
      env: '',
      city: '',
      branch: '',
      codeBranch: '',
      result: 'SUCCESS',
      testsRan: false,
      total: null,
      failed: 0,
      recoveredAfterRetry: 0,
      verdict: 'прогон зелёный',
      fingerprints: [],
      buildTimestamp: 600,
      durationMs: 60,
      commit: null,
      buildUrl: 'https://jenkins.example/job/backend/job/all-tests/6',
      model: '',
      analysisDurationMs: 0,
      tokensIn: 0,
      tokensOut: 0,
      server: 'jenkins'
    });

    await expect(recordRuns(client, config(), 'jenkins', 'backend/all-tests')).resolves.toMatchObject({ added: 0 });
    expect(readEntries(cacheDir).entries).toEqual(entries);
  });

  it('берёт окружение из параметра с именем, настроенным в environment', async () => {
    const client = new JenkinsClient(connection(config()), ((url: string) => {
      if (url.includes('tree=number')) {
        return Promise.resolve(new Response(JSON.stringify({
          number: 7,
          result: 'SUCCESS',
          timestamp: 700,
          duration: 70,
          actions: [{ parameters: [{ name: 'STAND', value: 'stage-2' }] }]
        }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        builds: [{ number: 7, result: 'SUCCESS', timestamp: 700, duration: 70 }]
      }), { status: 200 }));
    }) as unknown as typeof fetch);

    await recordRuns(
      client,
      config({ environment: { env: ['env', 'STAND'], city: ['city'] } }),
      'jenkins',
      'backend/all-tests'
    );

    expect(readEntries(cacheDir).entries[0]).toMatchObject({ env: 'stage-2' });
  });

  it('признак выполнения тестов учитывает настроенное имя артефакта отчёта', async () => {
    const withArtifactName = config({
      servers: { jenkins: server({ reportArtifact: 'report.zip', reportArtifactSource: 'file' }) }
    });
    const client = new JenkinsClient(connection(withArtifactName), ((url: string) => {
      if (url.includes('tree=number')) {
        return Promise.resolve(new Response(JSON.stringify({
          number: 7,
          result: 'SUCCESS',
          timestamp: 700,
          duration: 70,
          artifacts: [{ relativePath: 'report.zip' }]
        }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        builds: [{ number: 7, result: 'SUCCESS', timestamp: 700, duration: 70 }]
      }), { status: 200 }));
    }) as unknown as typeof fetch);

    await recordRuns(client, withArtifactName, 'jenkins', 'backend/all-tests');

    expect(readEntries(cacheDir).entries[0].testsRan).toBe(true);
  });

  it('прогон с непустым вердиктом исключается из списка «нужен разбор»', async () => {
    appendEntry(cacheDir, entry({
      build: 3,
      result: 'FAILURE',
      failed: 1,
      verdict: 'известная проблема, тикет заведён',
      fingerprints: ['точная причина']
    }));
    const client = new JenkinsClient(connection(config()), () =>
      Promise.resolve(new Response(JSON.stringify({
        builds: [{ number: 3, result: 'FAILURE', timestamp: 300, duration: 30 }]
      }), { status: 200 }))
    );

    const result = await recordRuns(client, config(), 'jenkins', 'backend/all-tests');

    expect(result.skippedAnalyzed).toBe(1);
    expect(result.needsReview).toEqual([]);
  });

  it('прогон с пустым вердиктом остаётся в списке «нужен разбор»', async () => {
    appendEntry(cacheDir, entry({ build: 3, result: 'FAILURE', failed: 1, verdict: '' }));
    const client = new JenkinsClient(connection(config()), () =>
      Promise.resolve(new Response(JSON.stringify({
        builds: [{ number: 3, result: 'FAILURE', timestamp: 300, duration: 30 }]
      }), { status: 200 }))
    );

    const result = await recordRuns(client, config(), 'jenkins', 'backend/all-tests');

    expect(result.skippedAnalyzed).toBe(0);
    expect(result.needsReview).toEqual([{ number: 3, result: 'FAILURE' }]);
  });
});

describe('Ответ команды учёта прогонов', () => {
  it('кладёт ключ «разобрано ранее» для пустого списка', () => {
    expect(asRecordRunsResponse({
      added: 0,
      filledEnv: 0,
      skippedAnalyzed: 0,
      needsReview: []
    })).toEqual({
      'добавлено': 0,
      'дозаполнено окружений': 0,
      'разобрано ранее': 0,
      'нужен разбор': []
    });
  });

  it('кладёт ключ «разобрано ранее» для непустого списка', () => {
    expect(asRecordRunsResponse({
      added: 1,
      filledEnv: 2,
      skippedAnalyzed: 3,
      needsReview: [{ number: 10, result: 'FAILURE' }]
    })).toEqual({
      'добавлено': 1,
      'дозаполнено окружений': 2,
      'разобрано ранее': 3,
      'нужен разбор': [{ number: 10, result: 'FAILURE' }]
    });
  });
});

function server(overrides: Partial<ResolvedServer> = {}): ResolvedServer {
  return {
    ...resolveServer('main', {}, undefined, {}),
    kind: 'jenkins',
    kindSource: 'file',
    baseUrl: 'https://jenkins.example',
    baseUrlSource: 'file',
    reportArtifact: 'allure-report.zip',
    reportArtifactSource: 'file',
    workspaceNodeMax: 40,
    workspaceNodeMaxSource: 'default',
    proxyUser: '',
    proxyUserSet: false,
    proxyUserSource: 'default',
    proxyPass: '',
    proxyPassSet: false,
    proxyPassSource: 'default',
    ...overrides
  };
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    servers: { jenkins: server() },
    cacheDir,
    repos: [],
    environment: DEFAULT_ENVIRONMENT,
    settings: { ...DEFAULT_SETTINGS },
    profileName: 'default',
    profileSource: 'default',
    description: '',
    profileFile: path.join(cacheDir, 'profile.json'),
    profileFileFound: true,
    credentialsFile: path.join(cacheDir, 'credentials.json'),
    ...overrides
  };
}

function connection(cfg: Config): JenkinsConnection {
  return {
    baseUrl: cfg.servers.jenkins.baseUrl,
    proxyUser: '',
    proxyPass: '',
    allowedJobs: cfg.allowedJobs,
    settings: cfg.settings,
    workspaceNodeMax: cfg.servers.jenkins.workspaceNodeMax
  };
}

function entry(overrides: Partial<JournalEntryInput>): JournalEntryInput {
  return {
    job: 'backend/all-tests',
    build: 1,
    analyzedAt: '2026-08-16T00:00:00.000Z',
    env: '',
    city: '',
    branch: '',
    codeBranch: '',
    result: 'SUCCESS',
    testsRan: true,
    total: null,
    failed: 0,
    recoveredAfterRetry: 0,
    verdict: 'прогон зелёный',
    fingerprints: [],
    model: '',
    analysisDurationMs: 0,
    ...overrides
  };
}


describe('Параллельная запись разбора', () => {
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
  it('дозаполнение перечитывает запись после сети и сохраняет новый вердикт и заполненные поля', async () => {
    const original = normalizeEntry({ job, build: 7, analyzedAt: '2026-01-01', testsRan: false });
    appendEntry(cache, original);
    const ci = {
      listAllRuns: () => Promise.resolve([]),
      getBuildMeta: () => {
        expect(readdirSync(cache)).not.toContain('journal.jsonl.lock');
        appendEntry(cache, { ...original, verdict: 'новый разбор', env: 'current', branch: 'current-branch' });
        return Promise.resolve({ parameters: { env: 'network', city: 'city-example', branch: 'stale' } });
      }
    } as unknown as CiClient;
    const result = await recordRuns(ci, config(), 'first', job);
    expect(readEntries(cache).entries[0]).toMatchObject({
      verdict: 'новый разбор', env: 'current', city: 'city-example', server: 'first', branch: 'current-branch',
      buildUrl: 'https://ci.example/job/folder/job/example-job/7'
    });
    expect(result.filledEnv).toBe(0);
  });
});
