import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JenkinsClient } from '../../src/jenkins/client.js';
import { getBuildMeta, listAllRuns, listJobs } from '../../src/jenkins/queries.js';
import type { JenkinsConnection } from '../../src/jenkins/client.js';
import { DEFAULT_SETTINGS } from '../../src/settings.js';

const config: JenkinsConnection = {
  baseUrl: 'http://example:8000',
  proxyUser: 'ci_reader',
  proxyPass: 'secret',
  allowedJobs: [],
  settings: { ...DEFAULT_SETTINGS },
  workspaceNodeMax: 40
};

describe('Клиент Jenkins', () => {
  it('подставляет заголовок HTTP Basic по умолчанию', async () => {
    let seenAuth = '';
    const fake = (url: string | URL, init?: RequestInit) => {
      seenAuth = String(new Headers(init?.headers).get('authorization'));
      return new Response('{"ok":true}', { status: 200 });
    };
    const client = new JenkinsClient(config, fake as unknown as typeof fetch);
    await client.getJson('api/json');
    const expected = 'Basic ' + Buffer.from('ci_reader:secret').toString('base64');
    expect(seenAuth).toBe(expected);
  });

  it('объясняет отказ в доступе', async () => {
    const fake = () => Promise.resolve(new Response('', { status: 401 }));
    const client = new JenkinsClient(config, fake);
    await expect(client.getJson('api/json')).rejects.toThrow(
      'Доступ к ресурсу не разрешён (режим basic)'
    );
  });

  it('объясняет отсутствие страницы', async () => {
    const fake = () => Promise.resolve(new Response('', { status: 404 }));
    const client = new JenkinsClient(config, fake);
    await expect(client.getJson('job/backend/job/Nope/api/json')).rejects.toThrow(
      'не найден'
    );
  });

  it('собирает адрес из базового и относительного пути', async () => {
    let seenUrl = '';
    const fake = (url: string | URL) => {
      seenUrl = String(url);
      return new Response('{}', { status: 200 });
    };
    const client = new JenkinsClient(config, fake as unknown as typeof fetch);
    await client.getJson('job/backend/api/json');
    expect(seenUrl).toBe('http://example:8000/job/backend/api/json');
  });

  it('отменяет зависший запрос по настроенному таймауту и называет адрес', async () => {
    const fake = (_url: string | URL, init?: RequestInit) => {
      if (!init?.signal) {
        throw new Error('сигнал отмены не передан');
      }
      return new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => {
          const reason = init.signal!.reason as unknown;
          reject(reason instanceof Error ? reason : new Error(String(reason)));
        });
      });
    };
    const client = new JenkinsClient({
      ...config,
      settings: { ...config.settings, requestTimeoutMs: 10 }
    }, fake as typeof fetch);

    await expect(client.getJson('api/json')).rejects.toThrow(/таймаут.*api\/json/i);
  });

  it('отменяет зависшее скачивание по отдельному таймауту и называет адрес', async () => {
    const fake = (_url: string | URL, init?: RequestInit) => {
      if (!init?.signal) {
        throw new Error('сигнал отмены не передан');
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason));
        }
      });
      return Promise.resolve(new Response(body));
    };
    const client = new JenkinsClient({
      ...config,
      settings: { ...config.settings, downloadTimeoutMs: 10 }
    }, fake as typeof fetch);
    const destination = mkdtempSync(path.join(tmpdir(), 'jenkins-download-'));
    try {
      await expect(
        client.download('artifact/file', path.join(destination, 'file.bin'))
      ).rejects.toThrow(/таймаут.*artifact\/file/i);
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  });

  it('разрешённая джоба проходит через сеть', async () => {
    let calls = 0;
    const fake = () => {
      calls += 1;
      return Promise.resolve(new Response('{"builds":[]}', { status: 200 }));
    };
    const client = new JenkinsClient(
      { ...config, allowedJobs: ['backend/all-tests'] },
      fake
    );

    await client.getJson('job/backend/job/all-tests/api/json', ' /BACKEND/ALL-TESTS/ ');

    expect(calls).toBe(1);
  });

  it('запрещённая джоба отвергается до сетевого запроса', async () => {
    let calls = 0;
    const fake = () => {
      calls += 1;
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    const client = new JenkinsClient(
      { ...config, allowedJobs: ['backend/all-tests'] },
      fake
    );

    await expect(
      client.getJson('job/backend/job/other-job/api/json', 'backend/other-job')
    ).rejects.toThrow('Разрешённые джобы: backend/all-tests');
    expect(calls).toBe(0);
  });

  it('при пустом списке разрешает любую джобу без учёта регистра', async () => {
    const fake = () => Promise.resolve(new Response('{}', { status: 200 }));
    const client = new JenkinsClient(
      { ...config, allowedJobs: [] },
      fake
    );

    await expect(client.getJson('job/backend/job/other-job/api/json', 'BACKEND/OTHER-JOB')).resolves.toEqual({});
  });

  it('перебирает node id до первого доступного рабочего каталога', async () => {
    const urls: string[] = [];
    const fake = (url: string | URL) => {
      urls.push(String(url));
      return new Response('', { status: urls.length === 3 ? 200 : 404 });
    };
    const client = new JenkinsClient(config, fake as unknown as typeof fetch);

    await expect(client.findWorkspaceNode('backend/all-tests', 81)).resolves.toBe(3);
    expect(urls).toEqual([
      'http://example:8000/job/backend/job/all-tests/81/execution/node/1/ws/',
      'http://example:8000/job/backend/job/all-tests/81/execution/node/2/ws/',
      'http://example:8000/job/backend/job/all-tests/81/execution/node/3/ws/'
    ]);
  });

  it('возвращает отсутствие workspace-архива для 403 или 404', async () => {
    const fake = () => Promise.resolve(new Response('', { status: 403 }));
    const client = new JenkinsClient(config, fake);

    await expect(
      client.downloadWorkspaceSource('backend/all-tests', 81, 18, 'unused.zip')
    ).resolves.toBeNull();
  });

});

describe('Метаданные билда', () => {
  it('сохраняет SHA-256 отпечаток архива исходников', async () => {
    const hash = 'a'.repeat(64);
    const fake = () => Promise.resolve(new Response(JSON.stringify({
      number: 30,
      result: 'SUCCESS',
      artifacts: [{ relativePath: 'src/test/java/tests/SmokeTest.java' }],
      fingerprints: [{ fileName: 'src.zip', hash }],
      actions: []
    }), { status: 200 }));
    const client = new JenkinsClient(config, fake);

    await expect(getBuildMeta(client, 'backend/all-tests', 30)).resolves.toMatchObject({
      sourceArchiveSha256: hash
    });
  });

  it('не принимает отпечаток другого алгоритма за SHA-256', async () => {
    const fake = () => Promise.resolve(new Response(JSON.stringify({
      number: 30,
      artifacts: [],
      fingerprints: [{ fileName: 'src.zip', hash: 'a'.repeat(32) }],
      actions: []
    }), { status: 200 }));
    const client = new JenkinsClient(config, fake);

    await expect(getBuildMeta(client, 'backend/all-tests', 30)).resolves.toMatchObject({
      sourceArchiveSha256: null
    });
  });
});

describe('Полный список прогонов', () => {
  it('одним запросом получает список без среза числа прогонов', async () => {
    const urls: string[] = [];
    const fake = (url: string | URL) => {
      urls.push(String(url));
      return new Response(JSON.stringify({
        builds: [
          { number: 31, result: 'SUCCESS', timestamp: 100, duration: 20 },
          { number: 30, result: null, timestamp: 90, duration: 0 }
        ]
      }), { status: 200 });
    };
    const client = new JenkinsClient(config, fake as unknown as typeof fetch);

    await expect(listAllRuns(client, 'backend/all-tests')).resolves.toEqual([
      { number: 31, result: 'SUCCESS', timestamp: 100, durationMs: 20 },
      { number: 30, result: null, timestamp: 90, durationMs: 0 }
    ]);
    expect(urls).toEqual([
      'http://example:8000/job/backend/job/all-tests/api/json?tree=builds[number,result,timestamp,duration]'
    ]);
  });
});

describe('Список джоб', () => {
  it('спускается внутрь папок и возвращает полные пути', async () => {
    const answers: Record<string, string> = {
      'http://example:8000/api/json?tree=jobs[name,color,_class]': JSON.stringify({
        jobs: [
          { name: 'backend', _class: 'com.cloudbees.hudson.plugins.folder.Folder' }
        ]
      }),
      'http://example:8000/job/backend/api/json?tree=jobs[name,color,_class]':
        JSON.stringify({
          jobs: [
            {
              name: 'smoke',
              color: 'blue',
              _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob'
            }
          ]
        })
    };
    const fake = (url: string | URL) =>
      new Response(answers[String(url)] ?? '{"jobs":[]}', { status: 200 });
    const client = new JenkinsClient(config, fake as unknown as typeof fetch);
    const result = await listJobs(client);
    expect(result.map((job) => job.path)).toEqual(['backend', 'backend/smoke']);
  });

  it('обходит папку, содержащую разрешённую джобу', async () => {
    const answers: Record<string, string> = {
      'http://example:8000/api/json?tree=jobs[name,color,_class]': JSON.stringify({
        jobs: [{ name: 'backend', _class: 'com.cloudbees.hudson.plugins.folder.Folder' }]
      }),
      'http://example:8000/job/backend/api/json?tree=jobs[name,color,_class]': JSON.stringify({
        jobs: [
          {
            name: 'smoke',
            color: 'blue',
            _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob'
          }
        ]
      })
    };
    const fake = (url: string | URL) =>
      new Response(answers[String(url)] ?? '{"jobs":[]}', { status: 200 });
    const client = new JenkinsClient(
      { ...config, allowedJobs: ['backend/smoke'] },
      fake as unknown as typeof fetch
    );

    const result = await listJobs(client);

    expect(result.map((job) => job.path)).toEqual(['backend', 'backend/smoke']);
  });

  it('отмечает папки отдельно от джоб', async () => {
    const fake = () =>
      Promise.resolve(new Response(
        JSON.stringify({
          jobs: [
            { name: 'Solo', color: 'red', _class: 'hudson.model.FreeStyleProject' }
          ]
        }),
        { status: 200 }
      ));
    const client = new JenkinsClient(config, fake);
    const result = await listJobs(client);
    expect(result[0].isFolder).toBe(false);
    expect(result[0].color).toBe('red');
  });
});
