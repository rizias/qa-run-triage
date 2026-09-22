import { describe, expect, it } from 'vitest';
import { lenientServerBaseUrl, requireServer, resolveServer, resolveServerNameForJob, type ResolvedServer } from '../src/serverResolution.js';

function server(overrides: Partial<ResolvedServer> = {}): ResolvedServer {
  return {
    ...resolveServer('main', {}, undefined, {}),
    kind: 'jenkins',
    kindSource: 'default',
    baseUrl: 'https://jenkins.example',
    baseUrlSource: 'file',
    reportArtifact: 'allure-report.zip',
    reportArtifactSource: 'default',
    workspaceNodeMax: 40,
    workspaceNodeMaxSource: 'default',
    proxyUser: 'reader',
    proxyUserSet: true,
    proxyUserSource: 'file',
    proxyPass: 'secret',
    proxyPassSet: true,
    proxyPassSource: 'file',
    ...overrides
  };
}

describe('Настройки сервера', () => {
  it('строит переменную окружения из имени сервера заглавными буквами', () => {
    const resolved = resolveServer(
      'jenkins-main',
      {},
      undefined,
      { QA_RUN_TRIAGE_SERVER_JENKINS_MAIN_BASE_URL: 'https://from-env.example' }
    );

    expect(resolved.baseUrl).toBe('https://from-env.example');
    expect(resolved.baseUrlSource).toBe('env');
  });

  it('поле сервера с непечатаемыми символами в имени заменяет их подчёркиванием', () => {
    const resolved = resolveServer(
      'my.server',
      {},
      undefined,
      { QA_RUN_TRIAGE_SERVER_MY_SERVER_BASE_URL: 'https://env.example' }
    );

    expect(resolved.baseUrl).toBe('https://env.example');
  });
});

describe('Адрес подключения без учётных данных', () => {
  it('baseUrl из файла с userinfo отвергается при разрешении и не печатает секрет', () => {
    let error: unknown;
    try {
      resolveServer('main', { baseUrl: 'https://ci_reader:совершенно_секретный_пароль@jenkins.example' }, undefined, {});
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/servers\.main\.baseUrl/);
    expect(message).not.toContain('совершенно_секретный_пароль');
  });

  it('baseUrl из переменной окружения с userinfo называет переменную без значения', () => {
    let error: unknown;
    try {
      resolveServer('main', {}, undefined, {
        QA_RUN_TRIAGE_SERVER_MAIN_BASE_URL: 'https://ci_reader:совершенно_секретный_пароль@jenkins.example'
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toMatch(/QA_RUN_TRIAGE_SERVER_MAIN_BASE_URL/);
    expect(message).not.toContain('совершенно_секретный_пароль');
  });
});

describe('Обязательные настройки сервера', () => {
  it('называет сервер, которого нет в servers', () => {
    expect(() => requireServer({}, 'main', '/profile.json', '/credentials.json')).toThrow(/main/);
  });

  it('не задан адрес — ошибка называет переменную, поле и файл профиля', () => {
    const servers = { main: server({ baseUrl: '', baseUrlSource: 'default' }) };

    expect(() => requireServer(servers, 'main', '/profile.json', '/credentials.json')).toThrow(
      /QA_RUN_TRIAGE_SERVER_MAIN_BASE_URL.*servers\.main\.baseUrl.*\/profile\.json/
    );
  });

  it('нет секрета — ошибка называет сервер, поле файла секретов и переменную', () => {
    const servers = {
      main: server({ proxyUser: '', proxyUserSet: false, proxyUserSource: 'default' })
    };

    expect(() => requireServer(servers, 'main', '/profile.json', '/credentials.json')).toThrow(
      /main.*QA_RUN_TRIAGE_SERVER_MAIN_PROXY_USER.*main\.proxyUser.*\/credentials\.json/
    );
  });

  it('все обязательные поля заданы — возвращает соединение', () => {
    const servers = { main: server() };

    expect(requireServer(servers, 'main', '/profile.json', '/credentials.json')).toEqual({
      auth: 'basic',
      baseUrl: 'https://jenkins.example',
      proxyUser: 'reader',
      proxyPass: 'secret',
      reportArtifact: 'allure-report.zip'
    });
  });
});

describe('Выбор сервера джобы', () => {
  it('джоба без группы, без defaultServer, серверов несколько — ошибка называет джобу и defaultServer', () => {
    expect(() => resolveServerNameForJob(undefined, undefined, ['main', 'ui'], 'backend/smoke')).toThrow(
      /backend\/smoke.*defaultServer/
    );
  });

  it('defaultServer применяется, когда своей группы нет', () => {
    expect(resolveServerNameForJob(undefined, 'main', ['main', 'ui'], 'backend/smoke')).toBe('main');
  });

  it('сервер совпавшей группы важнее defaultServer', () => {
    const jobs = { Playwright: { server: 'ui' } };
    expect(resolveServerNameForJob(jobs, 'main', ['main', 'ui'], 'Playwright/e2e')).toBe('ui');
  });

  it('единственный сервер подразумевается как умолчание без defaultServer', () => {
    expect(resolveServerNameForJob(undefined, undefined, ['jenkins'], 'backend/smoke')).toBe('jenkins');
  });

  it('jobs без папки при одном сервере не требует defaultServer', () => {
    expect(resolveServerNameForJob(undefined, undefined, ['jenkins'], '')).toBe('jenkins');
  });
});

describe('Адрес сервера для починки', () => {
  it('без имени сервера возвращает null', () => {
    expect(lenientServerBaseUrl({}, undefined)).toBeNull();
  });

  it('сервер не объявлен — возвращает null, не бросает', () => {
    expect(lenientServerBaseUrl({}, 'main')).toBeNull();
  });

  it('адрес не задан — возвращает null', () => {
    const servers = { main: server({ baseUrl: '', baseUrlSource: 'default' }) };
    expect(lenientServerBaseUrl(servers, 'main')).toBeNull();
  });

  it('адрес задан — возвращает значение', () => {
    const servers = { main: server() };
    expect(lenientServerBaseUrl(servers, 'main')).toBe('https://jenkins.example');
  });
});


describe('Диагностика отсутствующего сервера', () => {
  it('Нет сервера для джобы — ошибка называет джобу и поля jobs.<ключ>.server и defaultServer', () => {
      expect(() => resolveServerNameForJob(undefined, undefined, ['main', 'ui'], 'backend/smoke')).toThrow(
        /backend\/smoke.*jobs\.<ключ>\.server.*defaultServer/
      );
      expect(() => resolveServerNameForJob(undefined, undefined, [], 'backend/smoke')).toThrow(
        /backend\/smoke.*jobs\.<ключ>\.server.*defaultServer/
      );
    });
});
