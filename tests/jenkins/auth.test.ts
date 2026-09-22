import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createCiClient } from '../../src/ci/createClient.js';

afterEach(() => vi.restoreAllMocks());

describe('Заголовок аутентификации из спецификации настроек', () => {
  it.each([
    { auth: 'none', credentials: { proxyUser: 'reader', token: 'остаток' }, expected: null },
    { auth: 'basic', credentials: { proxyUser: 'reader', proxyPass: 'secret' }, expected: 'Basic cmVhZGVyOnNlY3JldA==' },
    { auth: 'token', credentials: { user: 'reader', token: 'api-token' }, expected: 'Basic cmVhZGVyOmFwaS10b2tlbg==' }
  ])('$auth передаёт ожидаемый заголовок для API и скачивания', async ({ auth, credentials, expected }) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jenkins-auth-'));
    const file = path.join(dir, 'profile.json');
    writeFileSync(file, JSON.stringify({ servers: { main: { auth, baseUrl: 'https://ci.example' } } }));
    writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ main: credentials }));
    const headers: Array<string | null> = [];
    const fake = (_url: string | URL | Request, init?: RequestInit) => {
      headers.push(new Headers(init?.headers).get('authorization'));
      return Promise.resolve(new Response('{"jobs":[]}'));
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(fake);
    const client = createCiClient(loadConfig({}, file), 'main');
    expect(await client.listJobs()).toEqual([]);
    const target = path.join(dir, 'artifact.txt');
    await client.downloadArtifact('folder/example-job', 1, 'artifact.txt', target);
    expect(readFileSync(target, 'utf8')).toBe('{"jobs":[]}');
    expect(headers).toEqual([expected, expected]);
  });

  it.each(['none', 'basic', 'token'])('%s использует режим и секреты из окружения', async (auth) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jenkins-auth-env-'));
    const file = path.join(dir, 'profile.json');
    writeFileSync(file, JSON.stringify({ servers: { main: { auth: 'none', baseUrl: 'https://ci.example' } } }));
    const credentials = auth === 'token' ? { user: 'старый', token: 'старый' } : { proxyUser: 'старый', proxyPass: 'старый' };
    writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ main: credentials }));
    const env: NodeJS.ProcessEnv = { QA_RUN_TRIAGE_SERVER_MAIN_AUTH: auth };
    if (auth === 'token') {
      env.QA_RUN_TRIAGE_SERVER_MAIN_USER = 'reader';
      env.QA_RUN_TRIAGE_SERVER_MAIN_TOKEN = 'api-token';
    } else {
      env.QA_RUN_TRIAGE_SERVER_MAIN_PROXY_USER = 'reader';
      env.QA_RUN_TRIAGE_SERVER_MAIN_PROXY_PASS = 'secret';
    }
    const fake = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"jobs":[]}'));
    const client = createCiClient(loadConfig(env, file), 'main');
    await client.listJobs();
    const header = new Headers(fake.mock.calls[0][1]?.headers).get('authorization');
    const expected = auth === 'token' ? 'Basic cmVhZGVyOmFwaS10b2tlbg==' : 'Basic cmVhZGVyOnNlY3JldA==';
    expect(header).toBe(auth === 'none' ? null : expected);
  });
});
