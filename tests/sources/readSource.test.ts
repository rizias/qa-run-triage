import { resolveServer } from '../../src/serverResolution.js';
import { DEFAULT_ENVIRONMENT } from '../../src/configFields.js';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { type Config } from '../../src/config.js';
import { DEFAULT_SETTINGS } from '../../src/settings.js';
import { runDir, sourceExtractedDir } from '../../src/fetcher/cachePaths.js';
import { readSourceForRun } from '../../src/sources/readSource.js';

let cacheDir: string;

function config(repos: string[] = []): Config {
  return {
    servers: {
      jenkins: {
        ...resolveServer('main', {}, undefined, {}),
        kind: 'jenkins',
        kindSource: 'file',
        baseUrl: '',
        baseUrlSource: 'default',
        reportArtifact: 'allure-report.zip',
        reportArtifactSource: 'default',
        workspaceNodeMax: 40,
        workspaceNodeMaxSource: 'default',
        proxyUser: '',
        proxyUserSet: false,
        proxyUserSource: 'default',
        proxyPass: '',
        proxyPassSet: false,
        proxyPassSource: 'default'
      }
    },
    cacheDir,
    repos,
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

function initRepo(origin: string): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-repo-'));
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repo, 'config', 'user.name', 'test']);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', origin]);
  return repo;
}

function commitFile(repo: string, relativePath: string, content: string): string {
  const file = path.join(repo, ...relativePath.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'seed']);
  return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function writeRunMeta(job: string, build: number, checkouts: { repository: string; commit: string }[]): void {
  const dir = runDir(cacheDir, job, build);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ checkouts }), 'utf8');
}

let repo: string;
let commit: string;

beforeAll(() => {
  repo = initRepo('https://git.example/team/backend-tests.git');
  commit = commitFile(repo, 'src/test/java/lib/ExampleTest.java', 'class ExampleTest { }\n');
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

beforeEach(() => {
  cacheDir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-read-source-'));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('Чтение исходника прогона', () => {
  it('при архиве в кэше клон не используется', async () => {
    const sha = 'e'.repeat(64);
    const dir = runDir(cacheDir, 'backend/smoke', 40);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ source: { sha256: sha } }), 'utf8');
    const extracted = path.join(sourceExtractedDir(cacheDir, sha), 'src', 'test', 'java', 'lib');
    mkdirSync(extracted, { recursive: true });
    writeFileSync(path.join(extracted, 'ExampleTest.java'), 'class FromArchive { }\n', 'utf8');

    const answer = await readSourceForRun(config(['C:/nonexistent-repo']), 'backend/smoke', 40, 'lib.ExampleTest');

    expect(answer.origin).toBe('archive');
    expect(answer.text).toBe('class FromArchive { }\n');
  });

  it('архива нет, ровно один клон совпал с checkout — читает файл и называет источник', async () => {
    writeRunMeta('backend/smoke', 40, [{ repository: 'team/backend-tests', commit }]);

    const answer = await readSourceForRun(config([repo]), 'backend/smoke', 40, 'lib.ExampleTest');

    expect(answer).toMatchObject({
      origin: 'repository',
      repository: 'team/backend-tests',
      commit,
      path: 'src/test/java/lib/ExampleTest.java',
      text: 'class ExampleTest { }\n'
    });
  });

  it('джоба вне зависимости от папки — читается по совпавшему checkout', async () => {
    writeRunMeta('Playwright/e2e', 41, [{ repository: 'team/backend-tests', commit }]);

    const answer = await readSourceForRun(config([repo]), 'Playwright/e2e', 41, 'lib.ExampleTest');

    expect(answer).toMatchObject({ origin: 'repository', commit });
  });

  it('коммит прогона неизвестен — нет ни архива, ни checkout', async () => {
    await expect(readSourceForRun(config([repo]), 'backend/smoke', 40, 'lib.ExampleTest')).rejects.toThrow(
      /Коммит прогона backend\/smoke #40 неизвестен/
    );
  });

  it('коммита нет в клоне', async () => {
    writeRunMeta('backend/smoke', 40, [{ repository: 'team/backend-tests', commit: '0'.repeat(40) }]);

    await expect(readSourceForRun(config([repo]), 'backend/smoke', 40, 'lib.ExampleTest')).rejects.toThrow(
      'нет в локальном клоне'
    );
  });

  it('файла нет в этом коммите', async () => {
    writeRunMeta('backend/smoke', 40, [{ repository: 'team/backend-tests', commit }]);

    await expect(readSourceForRun(config([repo]), 'backend/smoke', 40, 'lib.MissingTest')).rejects.toThrow(
      `Файла нет в коммите ${commit}`
    );
  });

  it('путь из repos не является репозиторием git', async () => {
    writeRunMeta('backend/smoke', 40, [{ repository: 'team/backend-tests', commit }]);
    const plainDir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-plain-'));
    try {
      await expect(readSourceForRun(config([plainDir]), 'backend/smoke', 40, 'lib.ExampleTest')).rejects.toThrow(
        'не является репозиторием git'
      );
    } finally {
      rmSync(plainDir, { recursive: true, force: true });
    }
  });

  it('коммит выбирается по checkout совпавшего репозитория, а не по другим checkout прогона', async () => {
    const other = initRepo('https://git.example/team/other-repo.git');
    try {
      const otherCommit = commitFile(other, 'src/test/java/lib/ExampleTest.java', 'class Other { }\n');
      writeRunMeta('Playwright/e2e', 42, [
        { repository: 'team/other-repo', commit: otherCommit },
        { repository: 'team/backend-tests', commit }
      ]);

      const answer = await readSourceForRun(config([repo]), 'Playwright/e2e', 42, 'lib.ExampleTest');

      expect(answer).toMatchObject({ origin: 'repository', repository: 'team/backend-tests', commit });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('несколько клонов подходят — ошибка со списком репозиториев', async () => {
    const second = initRepo('https://git.example/team/backend-tests-mirror.git');
    try {
      const secondCommit = commitFile(second, 'src/test/java/lib/ExampleTest.java', 'class Mirror { }\n');
      writeRunMeta('backend/smoke', 43, [
        { repository: 'team/backend-tests', commit },
        { repository: 'team/backend-tests-mirror', commit: secondCommit }
      ]);

      await expect(readSourceForRun(config([repo, second]), 'backend/smoke', 43, 'lib.ExampleTest')).rejects.toThrow(
        /Файл найден в нескольких клонах/
      );
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });

  it('ни один клон не подходит — ошибка перечисляет checkout и наличие клона', async () => {
    writeRunMeta('backend/smoke', 44, [{ repository: 'team/unrelated', commit }]);

    await expect(readSourceForRun(config([repo]), 'backend/smoke', 44, 'lib.ExampleTest')).rejects.toThrow(
      /team\/unrelated \(клон не найден в repos\)/
    );
  });

  it('клон найден, но чтение не удалось — агрегатная ошибка называет конкретную причину', async () => {
    writeRunMeta('backend/smoke', 45, [{ repository: 'team/backend-tests', commit: '0'.repeat(40) }]);

    await expect(readSourceForRun(config([repo]), 'backend/smoke', 45, 'lib.ExampleTest')).rejects.toThrow(
      /team\/backend-tests \(клон найден: Коммита 0{40} нет в локальном клоне/
    );
  });

  it('несколько checkout, ни один клон не читает файл — причина по каждому', async () => {
    writeRunMeta('backend/smoke', 46, [
      { repository: 'team/unrelated', commit },
      { repository: 'team/backend-tests', commit: '0'.repeat(40) }
    ]);

    let error: Error | undefined;
    try {
      await readSourceForRun(config([repo]), 'backend/smoke', 46, 'lib.ExampleTest');
    } catch (caught) {
      error = caught as Error;
    }

    expect(error?.message).toContain('team/unrelated (клон не найден в repos)');
    expect(error?.message).toContain('team/backend-tests (клон найден: Коммита');
  });

  it('Несколько неудачных клонов соединяют уникальные причины', async () => {
    const second = initRepo('https://git.example/team/backend-tests.git');
    try {
      commitFile(second, 'src/test/java/lib/Other.java', 'class Other {}\n');
      writeRunMeta('backend/smoke', 48, [{ repository: 'team/backend-tests', commit }]);
      await expect(
        readSourceForRun(config([repo, second]), 'backend/smoke', 48, 'lib.MissingTest')
      ).rejects.toThrow(/Файла нет в коммите[\s\S]*Коммита|Коммита[\s\S]*Файла нет в коммите/);
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });
});


describe('Чтение при неисправном клоне', () => {
  function commitFile(repo: string, relativePath: string, content: string): string {
    const file = path.join(repo, ...relativePath.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');
    execFileSync('git', ['-C', repo, 'add', '.']);
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'seed']);
    return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  }

  function initRepo(origin: string): string {
    const repo = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-rf-repo-'));
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'test']);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', origin]);
    return repo;
  }

  function sourceConfig(cacheDir: string, repos: string[] = []): Config {
    return {
      servers: {
        jenkins: {
          ...resolveServer('main', {}, undefined, {}),
          kind: 'jenkins',
          kindSource: 'file',
          baseUrl: '',
          baseUrlSource: 'default',
          reportArtifact: 'allure-report.zip',
          reportArtifactSource: 'default',
          workspaceNodeMax: 40,
          workspaceNodeMaxSource: 'default',
          proxyUser: '',
          proxyUserSet: false,
          proxyUserSource: 'default',
          proxyPass: '',
          proxyPassSet: false,
          proxyPassSource: 'default'
        }
      },
      cacheDir,
      repos,
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

  let cacheDir: string;
  beforeEach(() => { cacheDir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-cache-')); });
  afterEach(() => { rmSync(cacheDir, { recursive: true, force: true }); });

  it('Запись repos не git — причина в итоговой ошибке, другие клоны читаются', async () => {
      const repo = initRepo('https://git.example/team/backend-tests.git');
      const plain = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-rf-plain-'));
      try {
        const commit = commitFile(repo, 'src/test/java/lib/ExampleTest.java', 'class ExampleTest { }\n');
        const dir = runDir(cacheDir, 'backend/smoke', 40);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          path.join(dir, 'meta.json'),
          JSON.stringify({ checkouts: [{ repository: 'team/backend-tests', commit }] }),
          'utf8'
        );
        const answer = await readSourceForRun(
          sourceConfig(cacheDir, [plain, repo]),
          'backend/smoke',
          40,
          'lib.ExampleTest'
        );
        expect(answer.origin).toBe('repository');
        await expect(
          readSourceForRun(sourceConfig(cacheDir, [plain]), 'backend/smoke', 40, 'lib.ExampleTest')
        ).rejects.toThrow(/не является репозиторием git/);
      } finally {
        rmSync(repo, { recursive: true, force: true });
        rmSync(plain, { recursive: true, force: true });
      }
    });
});
