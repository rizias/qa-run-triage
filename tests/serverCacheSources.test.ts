import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { loadConfig, type Config } from '../src/config.js';
import { printCliError } from '../src/cli/printError.js';
import { parseArgs } from '../src/cli/args.js';
import { toSourcePaths } from '../src/sources/testPath.js';
import { JenkinsClient } from '../src/jenkins/client.js';
import { fetchRun } from '../src/fetcher/fetchRun.js';
import { assertCachedServer, connectionIdentity } from '../src/fetcher/cacheServer.js';
import { runDir } from '../src/fetcher/cachePaths.js';
import type { BuildMeta, CiClient } from '../src/ci/client.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';

function config(baseUrl = 'https://ci.example', name = 'main'): Config {
  const root = mkdtempSync(path.join(tmpdir(), 'control-'));
  const profile = path.join(root, 'profile.json');
  writeFileSync(profile, JSON.stringify({ servers: { [name]: { baseUrl } } }));
  return loadConfig({}, profile);
}

function client(): CiClient {
  const meta: BuildMeta = { number: 1, result: 'SUCCESS', timestamp: 1, durationMs: 1,
    artifacts: [], parameters: {}, commit: null };
  return {
    getBuildMeta: vi.fn(() => Promise.resolve(meta)),
    getLatestCompletedBuildMeta: vi.fn(() => Promise.resolve(meta)),
    findWorkspaceNode: vi.fn(() => Promise.resolve(null)),
    downloadConsoleLog: vi.fn((_job: string, _build: number, file: string) => {
      writeFileSync(file, 'лог');
      return Promise.resolve(3);
    })
  } as unknown as CiClient;
}

describe('Настройки сервера, идентичность кэша и исходники', () => {
  it.each([
    '{"main":{"proxyPass":SENSITIVE_VALUE}}',
    '{"main":{"SENSITIVE_VALUE":"x"}}',
    '{"SENSITIVE_VALUE":{}}'
  ])('секретный файл не раскрывается в диагностике: %s', (contents) => {
    const settings = config();
    writeFileSync(settings.credentialsFile, contents);
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      let failure: unknown;
      try { loadConfig({}, settings.profileFile); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).cause).toBeUndefined();
      printCliError(failure);
      const text = output.mock.calls.flat().join('\n');
      expect(text).toContain(settings.credentialsFile);
      expect(text).not.toContain('SENSITIVE_VALUE');
      if (contents.includes(':SENSITIVE')) expect(text).toMatch(/позиция \d+/);
    } finally { output.mockRestore(); }
  });

  it('сохраняет __proto__ через проверку профиля, секретов и разрешение сервера', () => {
    const settings = config('https://ci.example', '__proto__');
    writeFileSync(settings.credentialsFile, '{"__proto__":{"proxyUser":"reader","proxyPass":"sample"}}');
    const loaded = loadConfig({}, settings.profileFile);
    expect(Object.keys(loaded.servers)).toEqual(['__proto__']);
    expect(loaded.servers.__proto__.proxyPass).toBe('sample');
  });

  it.each(['', '--flag'])('source требует идентификатор %s', (identifier) => {
    expect(() => parseArgs(['source', 'folder/smoke', '7', identifier])).toThrow(/source <джоба> <билд> <идентификатор>/);
    expect(() => parseArgs(['source', 'folder/smoke', '7'])).toThrow(/идентификатор/);
  });

  it('распознаёт файл без каталога и проверяет путь без названия', () => {
    expect(toSourcePaths('root.spec.ts#название')).toEqual(['root.spec.ts']);
    expect(toSourcePaths('tests/root.spec.ts#обрабатывает C:\\folder')).toEqual(['tests/root.spec.ts']);
    expect(toSourcePaths('root.test.js › C:\\folder')).toEqual(['root.test.js']);
    expect(() => toSourcePaths('..\\root.spec.ts#название')).toThrow(/обратный слэш/);
  });

  it('кодирует имя артефакта, сохраняя служебный путь ZIP', async () => {
    const urls: string[] = [];
    const fakeFetch = ((url: string | URL) => {
      urls.push(String(url));
      return Promise.resolve(new Response('archive'));
    }) as typeof fetch;
    const ci = new JenkinsClient({ baseUrl: 'https://ci.example', proxyUser: 'reader', proxyPass: 'sample',
      settings: DEFAULT_SETTINGS, allowedJobs: [], workspaceNodeMax: 1 }, fakeFetch);
    const root = mkdtempSync(path.join(tmpdir(), 'artifact-'));
    await ci.downloadArtifact('folder/smoke', 1, 'report #1?.zip', path.join(root, 'report.zip'));
    await ci.downloadArtifact('folder/smoke', 1, 'src/*zip*/src.zip', path.join(root, 'src.zip'));
    expect(new URL(urls[0]).pathname).toBe('/job/folder/job/smoke/1/artifact/report%20%231%3F.zip');
    expect(new URL(urls[0]).hash).toBe('');
    expect(urls[1]).toContain('/artifact/src/*zip*/src.zip');
  });

  it('смена адреса при прежнем имени запрещает чтение и вызывает повторное скачивание', async () => {
    const first = config();
    const ci = client();
    const original = await fetchRun(ci, first, 'folder/smoke', 1, 'allure-report.zip');
    const second = { ...first, servers: { main: { ...first.servers.main, baseUrl: 'https://other.example' } } };
    expect(() => assertCachedServer(second, 'folder/smoke', 1)).toThrow(/fetch/);
    const updated = await fetchRun(ci, second, 'folder/smoke', 1, 'allure-report.zip');
    expect(vi.spyOn(ci, 'getBuildMeta')).toHaveBeenCalledTimes(2);
    expect(updated.serverIdentity).not.toBe(original.serverIdentity);
    expect(() => assertCachedServer(second, 'folder/smoke', 1)).not.toThrow();
  });

  it('нормализует подключение без секретов и принимает прежний манифест', async () => {
    expect(connectionIdentity('main', 'https://reader:sample@CI.EXAMPLE/'))
      .toBe(connectionIdentity('main', 'https://ci.example'));
    const settings = config();
    const root = runDir(settings.cacheDir, 'folder/smoke', 1);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ job: 'folder/smoke', build: 1, source: null }));
    const ci = client();
    await fetchRun(ci, settings, 'folder/smoke', 1, 'allure-report.zip');
    expect(vi.spyOn(ci, 'getBuildMeta')).not.toHaveBeenCalled();
    expect(() => assertCachedServer(settings, 'folder/smoke', 1)).not.toThrow();
  });

  it('ZIP рабочего каталога сверх предела завершает fetch ошибкой и очищается', async () => {
    const settings = config();
    const limited = { ...settings, settings: { ...settings.settings, archiveMaxBytes: 8 } };
    const ci = client();
    ci.findWorkspaceNode = vi.fn(() => Promise.resolve(1));
    ci.downloadWorkspaceSource = vi.fn((_job: string, _build: number, _node: number, file: string) => {
      const zip = new AdmZip();
      zip.addFile('src/test.ts', Buffer.alloc(32));
      zip.writeZip(file);
      return Promise.resolve(32);
    });
    await expect(fetchRun(ci, limited, 'folder/smoke', 1, 'allure-report.zip')).rejects.toThrow(/limits.archiveMaxBytes/);
    expect(existsSync(runDir(settings.cacheDir, 'folder/smoke', 1))).toBe(false);
    expect(readdirSync(path.join(settings.cacheDir, 'sources-by-hash'))).toEqual([]);
  });

  it('два сервера без defaultServer отвергаются', () => {
    const settings = config();
    writeFileSync(settings.profileFile, JSON.stringify({ servers: { a: {}, b: {} }, jobs: { one: { server: 'a' }, two: { server: 'b' } } }));
    expect(() => loadConfig({}, settings.profileFile)).toThrow(/defaultServer обязательно/);
  });
});
