import { describe, it, expect } from 'vitest';
import { matchStoredRepository, parseCheckouts, repositoryIdentityFromUrl } from '../../src/fetcher/checkouts.js';

const twoCheckoutsLog = [
  'Fetching changes from the remote Git repository',
  ' > git config remote.origin.url https://git.example/team/backend-tests.git # timeout=10',
  'Fetching upstream changes from https://git.example/team/backend-tests.git',
  'Checking out Revision c1bb4635d18569f192ed42d4cd416b3e8853e476 (main)',
  'Commit message: "pipeline changes"',
  '[2026-09-14T13:55:32.765Z] Cloning repository https://git.example/team-b/ui-tests.git',
  '[2026-09-14T13:55:32.801Z] Fetching upstream changes from https://git.example/team-b/ui-tests.git',
  '[2026-09-14T13:55:55.053Z] Checking out Revision f7787466c4d7dff0be5637801e241fea0fa78c4f (refs/remotes/origin/main)',
  '[2026-09-14T13:55:55.026Z]  > git config remote.origin.url https://git.example/team-b/ui-tests.git # timeout=10'
].join('\n');

describe('Репозитории и коммиты из лога', () => {
  it('лог с двумя checkout даёт оба репозитория и коммита', () => {
    expect(parseCheckouts(twoCheckoutsLog)).toEqual([
      { repository: 'team/backend-tests', commit: 'c1bb4635d18569f192ed42d4cd416b3e8853e476' },
      { repository: 'team-b/ui-tests', commit: 'f7787466c4d7dff0be5637801e241fea0fa78c4f' }
    ]);
  });

  it('лог с одним checkout даёт один репозиторий', () => {
    const log = [
      ' > git config remote.origin.url https://git.example/team/backend-tests.git # timeout=10',
      'Checking out Revision c1bb4635d18569f192ed42d4cd416b3e8853e476 (refs/remotes/origin/main)'
    ].join('\n');

    expect(parseCheckouts(log)).toEqual([
      { repository: 'team/backend-tests', commit: 'c1bb4635d18569f192ed42d4cd416b3e8853e476' }
    ]);
  });

  it('лог без checkout даёт пустой список', () => {
    expect(parseCheckouts('лог сборки без клонирования репозиториев')).toEqual([]);
  });

  it('повтор имени репозитория — берётся последнее упоминание', () => {
    const log = [
      ' > git config remote.origin.url https://git.example/team/backend-tests.git # timeout=10',
      'Checking out Revision 1111111111111111111111111111111111111111',
      ' > git config remote.origin.url https://git.example/team/backend-tests.git # timeout=10',
      'Checking out Revision 2222222222222222222222222222222222222222'
    ].join('\n');

    expect(parseCheckouts(log)).toEqual([
      { repository: 'team/backend-tests', commit: '2222222222222222222222222222222222222222' }
    ]);
  });
});

describe('Имя репозитория из адреса', () => {
  it('два последних сегмента без .git, без учёта регистра', () => {
    expect(repositoryIdentityFromUrl('https://git.example/Team/Backend-Tests.git')).toBe('team/backend-tests');
  });

  it('ssh-форма с двоеточием даёт ту же идентичность', () => {
    expect(repositoryIdentityFromUrl('ssh://git@git.example.com:team/tests')).toBe('team/tests');
  });

  it('scp-форма без ssh:// даёт ту же идентичность', () => {
    expect(repositoryIdentityFromUrl('git@git.example.com:team/tests.git')).toBe('team/tests');
  });
});

describe('Сопоставление сохранённого репозитория', () => {
  it('разные хосты, одинаковая идентичность совпадают', () => {
    const candidate = 'ssh://git@git.example.com:team/tests';
    expect(
      matchStoredRepository('https://git.example.com/team/tests.git', candidate, [candidate])
    ).toBe(true);
  });

  it('старое однослойное имя совпадает по последнему сегменту', () => {
    expect(matchStoredRepository('https://git.example.com/team/tests.git', 'tests', ['tests'])).toBe(true);
  });

  it('разные репозитории с одинаковым последним сегментом не совпадают при известных двух сегментах', () => {
    const candidate = 'https://git.example.com/team-b/tests.git';
    expect(
      matchStoredRepository('https://git.example.com/team-a/tests.git', candidate, [candidate])
    ).toBe(false);
  });
});


describe('Неоднозначность имени репозитория', () => {
  it('Односегментное имя репозитория неоднозначно, если последний сегмент не уникален', () => {
      expect(
        matchStoredRepository('tests', 'https://git.example/team-a/tests.git', [
          'https://git.example/team-a/tests.git',
          'https://git.example/team-b/tests.git'
        ])
      ).toBe(false);
      expect(
        matchStoredRepository('tests', 'https://git.example/team-a/tests.git', [
          'https://git.example/team-a/tests.git'
        ])
      ).toBe(true);
    });
});
