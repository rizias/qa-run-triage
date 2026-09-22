import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, readProfileFile } from '../src/config.js';
import { describeConfig } from '../src/configDescribe.js';
import { fakeHome } from './setup.js';
import { resolveServer } from '../src/serverResolution.js';

function tempProfileFile(contents: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-config-'));
  const file = path.join(dir, 'profile.json');
  writeFileSync(file, JSON.stringify(contents), 'utf8');
  return file;
}

function writeProfileFile(name: string, contents: Record<string, unknown>): string {
  const dir = path.join(fakeHome, '.qa-run-triage', 'profiles', name);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'profile.json');
  writeFileSync(file, JSON.stringify(contents), 'utf8');
  return file;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const noProfileFile = tempProfileFile({});

const withMainServer = {
  servers: { main: { kind: 'jenkins', baseUrl: 'http://example:8000' } }
};

const mainCreds = { main: { proxyUser: 'ci_reader', proxyPass: 'secret' } };

describe('loadConfig — серверы', () => {
  it('читает сервер из файла профиля и секретов', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-config-'));
    const file = path.join(dir, 'profile.json');
    writeFileSync(file, JSON.stringify(withMainServer), 'utf8');
    writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify(mainCreds), 'utf8');

    const config = loadConfig({}, file);

    expect(config.servers.main).toMatchObject({
      baseUrl: 'http://example:8000',
      baseUrlSource: 'file',
      proxyUser: 'ci_reader',
      proxyUserSet: true,
      proxyUserSource: 'file',
      proxyPassSet: true,
      proxyPassSource: 'file'
    });
  });

  it('срезает завершающий слэш у адреса сервера', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-config-'));
    const file = path.join(dir, 'profile.json');
    writeFileSync(
      file,
      JSON.stringify({ servers: { main: { baseUrl: 'http://example:8000/' } } }),
      'utf8'
    );

    const config = loadConfig({}, file);

    expect(config.servers.main.baseUrl).toBe('http://example:8000');
  });

  it('переменная окружения сервера перекрывает файл', () => {
    const file = tempProfileFile({ servers: { main: { baseUrl: 'https://from-file.example' } } });

    const config = loadConfig({ QA_RUN_TRIAGE_SERVER_MAIN_BASE_URL: 'https://from-env.example' }, file);

    expect(config.servers.main).toMatchObject({ baseUrl: 'https://from-env.example', baseUrlSource: 'env' });
  });

  it('имя переменной строится из имени сервера заглавными с подчёркиваниями', () => {
    const file = tempProfileFile({ servers: { 'jenkins-main': { baseUrl: 'https://file.example' } } });

    const config = loadConfig({ QA_RUN_TRIAGE_SERVER_JENKINS_MAIN_BASE_URL: 'https://env.example' }, file);

    expect(config.servers['jenkins-main'].baseUrl).toBe('https://env.example');
  });

  it('переменные читаются только для серверов, объявленных в servers', () => {
    const file = tempProfileFile({});

    const config = loadConfig(
      {
        QA_RUN_TRIAGE_SERVER_JENKINS_MAIN_BASE_URL: 'https://env.example',
        QA_RUN_TRIAGE_SERVER_JENKINS_MAIN_PROXY_USER: 'a',
        QA_RUN_TRIAGE_SERVER_JENKINS_MAIN_PROXY_PASS: 'b'
      },
      file
    );

    expect(config.servers['jenkins-main']).toBeUndefined();
  });

  it('пустая переменная сервера — заданное, но пустое значение', () => {
    const file = tempProfileFile({ servers: { main: { baseUrl: 'https://file.example' } } });

    const config = loadConfig({ QA_RUN_TRIAGE_SERVER_MAIN_BASE_URL: '' }, file);

    expect(config.servers.main.baseUrl).toBe('');
    expect(config.servers.main.baseUrlSource).toBe('env');
  });

  it('reportArtifact по умолчанию — allure-report.zip', () => {
    const file = tempProfileFile({ servers: { main: {} } });

    const config = loadConfig({}, file);

    expect(config.servers.main).toMatchObject({ reportArtifact: 'allure-report.zip', reportArtifactSource: 'default' });
  });

  it('своё имя артефакта отчёта задаётся в файле', () => {
    const file = tempProfileFile({ servers: { main: { reportArtifact: 'report.zip' } } });

    const config = loadConfig({}, file);

    expect(config.servers.main.reportArtifact).toBe('report.zip');
  });
});

describe('файл профиля в каталоге пользователя', () => {
  it('allowedJobs берётся только из файла', () => {
    const file = tempProfileFile({ allowedJobs: ['backend/all-tests', 'backend/smoke'] });
    const config = loadConfig({}, file);
    expect(config.allowedJobs).toEqual(['backend/all-tests', 'backend/smoke']);
  });

  it('отсутствие списка разрешённых джоб разрешает всё', () => {
    expect(loadConfig({}, noProfileFile).allowedJobs).toEqual([]);
  });

  it('файл по умолчанию не считается явно заданным', () => {
    expect(readProfileFile({}).selection.explicitFile).toBe(false);
    expect(readProfileFile({}).selection.source).toBe('default');
  });

  it('отсутствие явно заданного файла не мешает при пустом профиле', () => {
    expect(() => loadConfig({})).not.toThrow();
  });

  it('явно заданный отсутствующий файл — ошибка с полным путём', () => {
    const missing = path.join(tmpdir(), 'qa-run-triage-no-such-config.json');
    expect(() => loadConfig({}, missing)).toThrow(new RegExp(escapeRegExp('qa-run-triage-no-such-config.json')));
  });

  it('--config важнее профиля', () => {
    writeProfileFile('config-flag-loses', { servers: { main: { baseUrl: 'https://from-profile.example' } } });
    const fromFlag = tempProfileFile({ servers: { main: { baseUrl: 'https://from-flag.example' } } });

    const config = loadConfig({}, fromFlag, 'config-flag-loses');

    expect(config.servers.main.baseUrl).toBe('https://from-flag.example');
  });

  it('describeConfig показывает источник и не печатает пароль', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-config-'));
    const file = path.join(dir, 'profile.json');
    writeFileSync(file, JSON.stringify(withMainServer), 'utf8');
    writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify(mainCreds), 'utf8');

    const shown = describeConfig({}, file);

    expect(shown.profileFile).toBe(file);
    expect(shown.profileFileFound).toBe(true);
    expect(JSON.stringify(shown)).not.toContain('secret');
    const server = shown.servers.find((item) => item.name === 'main');
    expect(server?.proxyPass).toMatchObject({ set: true, source: 'file' });
    expect(server?.proxyUser).toMatchObject({ set: true, source: 'file' });
  });

  it('describeConfig называет источник env и default рядом', () => {
    const shown = describeConfig(
      { QA_RUN_TRIAGE_SERVER_MAIN_BASE_URL: 'https://jenkins.example' },
      tempProfileFile({ servers: { main: {} } })
    );

    const server = shown.servers.find((item) => item.name === 'main');
    expect(server?.baseUrl).toMatchObject({ source: 'env', value: 'https://jenkins.example' });
    expect(shown.cacheDir.source).toBe('default');
  });
});

describe('строгая схема файла профиля', () => {
  it('неизвестное поле — ошибка с именем поля и путём файла', () => {
    const file = tempProfileFile({ unknownField: 1 });
    expect(() => loadConfig({}, file)).toThrow(
      new RegExp(`unknownField.*${escapeRegExp(file)}|${escapeRegExp(file)}.*unknownField`)
    );
  });

  it('старое поле ci верхнего уровня — неизвестное поле', () => {
    const file = tempProfileFile({ ci: { baseUrl: 'https://jenkins.example' } });
    expect(() => loadConfig({}, file)).toThrow(/неизвестное поле ci/);
  });

  it('неизвестное поле внутри servers называет путь через точку', () => {
    const file = tempProfileFile({ servers: { main: { proxyHost: 'x' } } });
    expect(() => loadConfig({}, file)).toThrow(/servers\.main\.proxyHost/);
  });

  it('старые имена пределов — неизвестное поле', () => {
    const oldNames = [
      'jenkinsRequestTimeoutMs',
      'jenkinsDownloadTimeoutMs',
      'jenkinsRunListDefault',
      'jenkinsRunListMax',
      'jenkinsWorkspaceNodeMax'
    ];
    for (const name of oldNames) {
      const file = tempProfileFile({ limits: { [name]: 1 } });
      expect(() => loadConfig({}, file)).toThrow(new RegExp(`limits\\.${name}`));
    }
  });

  it('workspaceNodeMax сервера Jenkins задаётся файлом и переменной', () => {
    const file = tempProfileFile({ servers: { main: { kind: 'jenkins', workspaceNodeMax: 7 } } });
    expect(loadConfig({}, file).servers.main.workspaceNodeMax).toBe(7);
    expect(loadConfig({}, file).servers.main.workspaceNodeMaxSource).toBe('file');
    expect(
      loadConfig({ QA_RUN_TRIAGE_SERVER_MAIN_WORKSPACE_NODE_MAX: '9' }, file).servers.main
    ).toMatchObject({ workspaceNodeMax: 9, workspaceNodeMaxSource: 'env' });
    expect(loadConfig({}, tempProfileFile({ servers: { main: {} } })).servers.main).toMatchObject({
      workspaceNodeMax: 40,
      workspaceNodeMaxSource: 'default'
    });
  });

  it('servers.<имя>.kind с недопустимым значением — ошибка с перечнем', () => {
    const file = tempProfileFile({ servers: { main: { kind: 'github' } } });
    expect(() => loadConfig({}, file)).toThrow(/servers\.main\.kind.*jenkins/);
  });

  it('имя сервера с недопустимыми символами — ошибка', () => {
    const file = tempProfileFile({ servers: { 'my server': {} } });
    expect(() => loadConfig({}, file)).toThrow(/[Ии]мя сервера/);
  });

  it('jobs не словарь — ошибка называет поле', () => {
    const file = tempProfileFile({ jobs: 'backend' });
    expect(() => loadConfig({}, file)).toThrow(/jobs/);
  });

  it('jobs.<группа>.server неверного типа — ошибка называет путь поля', () => {
    const file = tempProfileFile({ jobs: { backend: { server: 5 } } });
    expect(() => loadConfig({}, file)).toThrow(/jobs\.backend\.server/);
  });

  it('jobs.<группа>.repo неверного типа — ошибка называет путь поля', () => {
    const file = tempProfileFile({ jobs: { backend: { repo: 5 } } });
    expect(() => loadConfig({}, file)).toThrow(/jobs\.backend\.repo/);
  });

  it('jobs.<группа>.environment — ошибка называет путь поля', () => {
    const file = tempProfileFile({
      servers: { main: { kind: 'jenkins' } },
      jobs: { backend: { server: 'main', environment: { env: ['env'] } } }
    });
    expect(() => loadConfig({}, file)).toThrow(/jobs\.backend\.environment/);
  });

  it('неверный тип allowedJobs — ошибка называет поле и ожидаемый тип', () => {
    const file = tempProfileFile({ allowedJobs: 'backend/smoke' });
    expect(() => loadConfig({}, file)).toThrow(/allowedJobs.*строк/);
  });

  it('число вне диапазона в limits — ошибка называет поле', () => {
    const file = tempProfileFile({ limits: { cacheKeepRuns: -1 } });
    expect(() => loadConfig({}, file)).toThrow(/limits\.cacheKeepRuns/);
  });

  it('корень файла не объект — ошибка', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-config-'));
    const file = path.join(dir, 'profile.json');
    writeFileSync(file, '[1,2,3]', 'utf8');
    expect(() => loadConfig({}, file)).toThrow(/объект JSON/);
  });

  it('битый JSON — ошибка', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-config-'));
    const file = path.join(dir, 'profile.json');
    writeFileSync(file, '{не json', 'utf8');
    expect(() => loadConfig({}, file)).toThrow(/JSON/);
  });

  it('файл секретов не JSON — ошибка называет путь секретов', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-config-'));
    const file = path.join(dir, 'profile.json');
    writeFileSync(file, '{}', 'utf8');
    writeFileSync(path.join(dir, 'credentials.json'), '{не json', 'utf8');
    expect(() => loadConfig({}, file)).toThrow(/JSON/);
  });

  it('поле токена в режиме basic — ошибка с сервером и полем', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-config-'));
    const file = path.join(dir, 'profile.json');
    writeFileSync(file, JSON.stringify({ servers: { main: {} } }), 'utf8');
    writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ main: { token: 'x' } }), 'utf8');
    expect(() => loadConfig({}, file)).toThrow(/main.*basic.*main\.token/);
  });
});

describe('ссылки на сервер', () => {
  it('jobs.<группа>.server ссылается на сервер, которого нет в servers', () => {
    const file = tempProfileFile({ servers: { main: {} }, jobs: { Playwright: { server: 'ui' } } });
    expect(() => loadConfig({}, file)).toThrow(/jobs\.Playwright\.server/);
  });

  it('запись файла секретов ссылается на сервер, которого нет в servers', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-config-'));
    const file = path.join(dir, 'profile.json');
    writeFileSync(file, JSON.stringify({ servers: { main: {} } }), 'utf8');
    writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({ other: { proxyUser: 'a' } }), 'utf8');
    expect(() => loadConfig({}, file)).toThrow(/которого нет в servers/);
  });
});

describe('путь файла профиля', () => {
  it('лежит в профиле default каталога .qa-run-triage домашней папки', () => {
    const shown = describeConfig({});
    expect(shown.profileFile).toBe(path.join(fakeHome, '.qa-run-triage', 'profiles', 'default', 'profile.json'));
    expect(shown.credentialsFile).toBe(
      path.join(fakeHome, '.qa-run-triage', 'profiles', 'default', 'credentials.json')
    );
  });

  it('не зависит от APPDATA и XDG_CONFIG_HOME', () => {
    const shown = describeConfig({ APPDATA: 'C:/somewhere', XDG_CONFIG_HOME: '/elsewhere' });
    expect(shown.profileFile).toBe(path.join(fakeHome, '.qa-run-triage', 'profiles', 'default', 'profile.json'));
  });
});

describe('каталог данных', () => {
  it('по умолчанию — profiles/default/cache', () => {
    expect(loadConfig({}).cacheDir).toBe(path.join(fakeHome, '.qa-run-triage', 'profiles', 'default', 'cache'));
  });

  it('при --config каталог данных лежит рядом с файлом', () => {
    const file = tempProfileFile({});
    expect(loadConfig({}, file).cacheDir).toBe(path.join(path.dirname(file), 'cache'));
  });

  it('переменная QA_RUN_TRIAGE_CACHE_DIR перекрывает вычисленный каталог', () => {
    const file = tempProfileFile({});
    expect(loadConfig({ QA_RUN_TRIAGE_CACHE_DIR: 'C:\\override' }, file).cacheDir).toBe('C:\\override');
  });
});

describe('файл заметок', () => {
  it('по умолчанию — notes.md рядом с profile.json профиля default', () => {
    const shown = describeConfig({});
    expect(shown.notesFile).toBe(path.join(fakeHome, '.qa-run-triage', 'profiles', 'default', 'notes.md'));
    expect(shown.notesFileFound).toBe(false);
  });
});

describe('профили', () => {
  it('профиль флагом читает файл profiles/<имя>/profile.json', () => {
    writeProfileFile('team-b', { servers: { main: { baseUrl: 'https://team-b.example' } } });

    const config = loadConfig({}, undefined, 'team-b');

    expect(config.servers.main.baseUrl).toBe('https://team-b.example');
    expect(config.profileName).toBe('team-b');
    expect(config.profileSource).toBe('flag');
  });

  it('профиль переменной QA_RUN_TRIAGE_PROFILE', () => {
    writeProfileFile('team-c', { servers: { main: { baseUrl: 'https://team-c.example' } } });

    const config = loadConfig({ QA_RUN_TRIAGE_PROFILE: 'team-c' });

    expect(config.servers.main.baseUrl).toBe('https://team-c.example');
    expect(config.profileSource).toBe('env');
  });

  it('--profile важнее QA_RUN_TRIAGE_PROFILE', () => {
    writeProfileFile('flag-wins', { servers: { main: { baseUrl: 'https://flag-wins.example' } } });
    writeProfileFile('env-loses', { servers: { main: { baseUrl: 'https://env-loses.example' } } });

    const config = loadConfig({ QA_RUN_TRIAGE_PROFILE: 'env-loses' }, undefined, 'flag-wins');

    expect(config.servers.main.baseUrl).toBe('https://flag-wins.example');
  });

  it('отсутствующий профиль — ошибка с полным путём', () => {
    expect(() => loadConfig({}, undefined, 'team-missing')).toThrow(
      new RegExp(
        escapeRegExp(path.join(fakeHome, '.qa-run-triage', 'profiles', 'team-missing', 'profile.json'))
      )
    );
  });

  it('имя профиля с недопустимыми символами — ошибка', () => {
    expect(() => loadConfig({}, undefined, '../etc')).toThrow(/[Ии]мя профиля/);
  });

  it('profile из общего файла выбирается, когда нет флага, переменной и привязки', () => {
    writeProfileFile('team-d', { servers: { main: { baseUrl: 'https://team-d.example' } } });
    const commonDir = path.join(fakeHome, '.qa-run-triage');
    mkdirSync(commonDir, { recursive: true });
    const commonFile = path.join(commonDir, 'config.json');
    writeFileSync(commonFile, JSON.stringify({ profile: 'team-d' }), 'utf8');
    try {
      const config = loadConfig({});
      expect(config.servers.main.baseUrl).toBe('https://team-d.example');
      expect(config.profileSource).toBe('config');
    } finally {
      rmSync(commonFile, { force: true });
    }
  });

  it('привязка папки выбирает профиль по самому длинному совпадению', () => {
    writeProfileFile('bound-profile', { servers: { main: { baseUrl: 'https://bound.example' } } });
    const project = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-project-'));
    const commonDir = path.join(fakeHome, '.qa-run-triage');
    mkdirSync(commonDir, { recursive: true });
    const commonFile = path.join(commonDir, 'config.json');
    writeFileSync(
      commonFile,
      JSON.stringify({ profile: 'default', bindings: { [project]: 'bound-profile' } }),
      'utf8'
    );
    try {
      const config = loadConfig({}, undefined, undefined, path.join(project, 'nested'));
      expect(config.servers.main.baseUrl).toBe('https://bound.example');
      expect(config.profileSource).toBe('binding');
    } finally {
      rmSync(commonFile, { force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });
});


describe('Имена серверов и источники настроек', () => {
  function tempProfile(contents: Record<string, unknown>): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-rf-'));
    const file = path.join(dir, 'profile.json');
    writeFileSync(file, JSON.stringify(contents), 'utf8');
    return file;
  }

  it('Два имени сервера с одним префиксом переменных — ошибка', () => {
      const file = tempProfile({
        servers: {
          'foo-bar': { kind: 'jenkins' },
          foo_bar: { kind: 'jenkins' }
        }
      });
      expect(() => loadConfig({}, file)).toThrow(/foo-bar[\s\S]*foo_bar|foo_bar[\s\S]*foo-bar/);
    });

  it('config показывает jobs, environment и defaultServer со значением и источником; пустой секрет из env задан', () => {
      const file = tempProfile({
        servers: { main: { kind: 'jenkins' } },
        jobs: { Playwright: { server: 'main' } },
        environment: { env: ['STAND'], city: ['city'] }
      });
      writeFileSync(path.join(path.dirname(file), 'credentials.json'), '{}', 'utf8');
      const shown = describeConfig(
        { QA_RUN_TRIAGE_SERVER_MAIN_PROXY_USER: '', QA_RUN_TRIAGE_SERVER_MAIN_PROXY_PASS: '' },
        file
      );
      expect(shown.jobs).toMatchObject({ source: 'file' });
      expect(shown.environment).toMatchObject({ source: 'file' });
      expect(shown.defaultServer).toMatchObject({ source: 'default', value: 'main' });
      const server = shown.servers.find((item) => item.name === 'main');
      expect(server?.proxyUser).toMatchObject({ set: true, source: 'env' });
      expect(server?.proxyPass).toMatchObject({ set: true, source: 'env' });
    });
});


describe('Безопасность имени артефакта', () => {
  let cache: string;

  beforeEach(() => { cache = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-cache-')); });
  afterEach(() => { vi.restoreAllMocks(); rmSync(cache, { recursive: true, force: true }); });

  it.each(['../report.zip', '..\\report.zip', 'C:report.zip', 'a/b.zip', 'a\\b.zip', 'a\u0000.zip', '..', ''])(
    'настройка отвергает опасное имя артефакта %j и называет поле', (reportArtifact) => {
    const file = path.join(cache, 'profile.json');
    writeFileSync(file, JSON.stringify({ servers: { main: { reportArtifact } } }));
    expect(() => loadConfig({}, file)).toThrow('servers.main.reportArtifact');
    expect(() => resolveServer('main', {}, undefined, { QA_RUN_TRIAGE_SERVER_MAIN_REPORT_ARTIFACT: reportArtifact }))
      .toThrow('servers.main.reportArtifact');
  });
});
