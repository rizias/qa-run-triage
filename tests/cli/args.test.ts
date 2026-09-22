import { describe, it, expect } from 'vitest';
import { assertCommandAllowed } from '../../src/cli/index.js';
import { extractConfigFlag, parseArgs } from '../../src/cli/args.js';

describe('Разбор аргументов команд', () => {
  it('разбирает команду списка прогонов', () => {
    expect(parseArgs(['runs', 'backend/smoke'])).toEqual({
      kind: 'runs',
      job: 'backend/smoke',
      limit: 20
    });
  });

  it('принимает предел числа прогонов', () => {
    expect(parseArgs(['runs', 'backend/smoke', '5'])).toEqual({
      kind: 'runs',
      job: 'backend/smoke',
      limit: 5
    });
  });

  it('разбирает команду дозаписи прогонов', () => {
    expect(parseArgs(['record-runs', 'backend/smoke'])).toEqual({
      kind: 'record-runs',
      job: 'backend/smoke'
    });
  });

  it('разбирает команду скачивания', () => {
    expect(parseArgs(['fetch', 'backend/all-tests', '30'])).toEqual({
      kind: 'fetch',
      job: 'backend/all-tests',
      build: 30
    });
  });

  it('разбирает команду сводки', () => {
    expect(parseArgs(['summary', 'backend/all-tests', '30'])).toEqual({
      kind: 'summary',
      job: 'backend/all-tests',
      build: 30
    });
  });

  it('разбирает ключ принудительной перекачки', () => {
    expect(parseArgs(['fetch', 'backend/all-tests', '30', '--force'])).toEqual({
      kind: 'fetch',
      job: 'backend/all-tests',
      build: 30,
      force: true
    });
  });

  it('разбирает команду чтения исходника', () => {
    expect(parseArgs(['source', 'backend/all-tests', '30', 'tests.SmokeTest'])).toEqual({
      kind: 'source',
      job: 'backend/all-tests',
      build: 30,
      testClass: 'tests.SmokeTest'
    });
  });

  it('разбирает каталог статического HTML-отчёта и окно', () => {
    expect(parseArgs(['report', '--out-dir', 'reports', '--window-days', '30'])).toEqual({
      kind: 'report',
      outDir: 'reports',
      windowDays: 30
    });
  });

  it('разбирает команду починки отпечатков', () => {
    expect(parseArgs(['repair'])).toEqual({ kind: 'repair' });
  });

  it('разбирает команду падений с ключом восстановленных', () => {
    expect(parseArgs(['failures', 'backend/all-tests', '30', '--recovered'])).toEqual({
      kind: 'failures',
      job: 'backend/all-tests',
      build: 30,
      include: 'recovered'
    });
  });

  it('сообщает о неизвестной команде', () => {
    expect(() => parseArgs(['выдумка'])).toThrow('Неизвестная команда');
  });

  it('сообщает об отсутствии аргументов', () => {
    expect(() => parseArgs([])).toThrow('Укажите команду');
  });
});

describe('Граница доступа команды', () => {
  it('отказывает в джобе вне списка', () => {
    expect(() =>
      assertCommandAllowed(['backend/smoke'], parseArgs(['summary', 'backend/other', '1']))
    ).toThrow(/allowedJobs/);
  });

  it('пропускает разрешённую джобу', () => {
    expect(() =>
      assertCommandAllowed(['backend/smoke'], parseArgs(['summary', 'backend/smoke', '1']))
    ).not.toThrow();
  });

  it('пропускает команду без джобы', () => {
    expect(() => assertCommandAllowed(['backend/smoke'], parseArgs(['repair']))).not.toThrow();
  });

  it('при пустом списке разрешает любую джобу', () => {
    expect(() => assertCommandAllowed([], parseArgs(['summary', 'backend/other', '1']))).not.toThrow();
  });
});

describe('assertCommandAllowed — все команды с джобой', () => {
  const commandsWithJob: Array<[string, string[]]> = [
    ['runs', ['runs', 'backend/other', '5']],
    ['record-runs', ['record-runs', 'backend/other']],
    ['fetch', ['fetch', 'backend/other', '30']],
    ['source', ['source', 'backend/other', '30', 'tests.SmokeTest']],
    ['summary', ['summary', 'backend/other', '30']],
    ['failures', ['failures', 'backend/other', '30']]
  ];

  it.each(commandsWithJob)('%s отказывает в джобе вне списка', (_name, argv) => {
    expect(() =>
      assertCommandAllowed(['backend/smoke'], parseArgs(argv))
    ).toThrow(/allowedJobs/);
  });

  it.each(commandsWithJob)('%s пропускает джобу из списка', (_name, argv) => {
    const argvAllowed = argv.map((value) => (value === 'backend/other' ? 'backend/smoke' : value));
    expect(() =>
      assertCommandAllowed(['backend/smoke'], parseArgs(argvAllowed))
    ).not.toThrow();
  });
});

describe('assertCommandAllowed — команды без джобы', () => {
  const commandsWithoutJob: Array<[string, string[]]> = [
    ['report', ['report']],
    ['repair', ['repair']],
    ['config', ['config']],
    ['journal-append', ['journal-append']],
    ['init', ['init']],
    ['update', ['update']]
  ];

  it.each(commandsWithoutJob)('%s проходит границу доступа всегда', (_name, argv) => {
    expect(() =>
      assertCommandAllowed(['backend/smoke'], parseArgs(argv))
    ).not.toThrow();
  });
});

describe('команда config', () => {
  it('разбирается без аргументов в режим показа', () => {
    expect(parseArgs(['config'])).toEqual({ kind: 'config', mode: 'show' });
  });

  it('разбирает --json', () => {
    expect(parseArgs(['config', '--json'])).toEqual({ kind: 'config', mode: 'json' });
  });

  it('разбирает init', () => {
    expect(parseArgs(['config', 'init'])).toEqual({ kind: 'config', mode: 'init' });
  });

  it('разбирает profiles', () => {
    expect(parseArgs(['config', 'profiles'])).toEqual({ kind: 'config', mode: 'profiles' });
  });

  it('отказывает в лишних аргументах', () => {
    expect(() => parseArgs(['config', 'что-то'])).toThrow('Для config используйте');
  });

  it('не требует джобы и проходит границу доступа', () => {
    expect(() => assertCommandAllowed(['backend/smoke'], parseArgs(['config']))).not.toThrow();
  });
});

describe('команда config use', () => {
  it('разбирает имя профиля', () => {
    expect(parseArgs(['config', 'use', 'team-b'])).toEqual({ kind: 'config-use', profile: 'team-b' });
  });

  it('требует имя профиля', () => {
    expect(() => parseArgs(['config', 'use'])).toThrow('Для config используйте');
  });

  it('не требует джобы и проходит границу доступа', () => {
    expect(() =>
      assertCommandAllowed(['backend/smoke'], parseArgs(['config', 'use', 'team-b']))
    ).not.toThrow();
  });
});

describe('Выбор файла и профиля флагами', () => {
  it('извлекает --config до имени команды', () => {
    expect(extractConfigFlag(['--config', '/path/config.json', 'config'])).toEqual({
      configFile: '/path/config.json',
      rest: ['config']
    });
  });

  it('извлекает --config после имени команды', () => {
    expect(extractConfigFlag(['runs', 'backend/smoke', '--config', '/path/config.json'])).toEqual({
      configFile: '/path/config.json',
      rest: ['runs', 'backend/smoke']
    });
  });

  it('не меняет argv, когда флага нет', () => {
    expect(extractConfigFlag(['runs', 'backend/smoke'])).toEqual({
      configFile: undefined,
      rest: ['runs', 'backend/smoke']
    });
  });

  it('требует значение у --config', () => {
    expect(() => extractConfigFlag(['config', '--config'])).toThrow('--config');
  });

  it('извлекает --profile', () => {
    expect(extractConfigFlag(['runs', 'backend/smoke', '--profile', 'team-b'])).toEqual({
      configFile: undefined,
      profile: 'team-b',
      rest: ['runs', 'backend/smoke']
    });
  });

  it('требует значение у --profile', () => {
    expect(() => extractConfigFlag(['config', '--profile'])).toThrow('--profile');
  });

  it('извлекает и --config, и --profile одновременно', () => {
    expect(extractConfigFlag(['--config', '/path/config.json', '--profile', 'team-b', 'config'])).toEqual({
      configFile: '/path/config.json',
      profile: 'team-b',
      rest: ['config']
    });
  });
});

describe('команда journal-append', () => {
  it('разбирается без аргументов', () => {
    expect(parseArgs(['journal-append'])).toEqual({ kind: 'journal-append' });
  });

  it('джобу не принимает, границу доступа проходит', () => {
    expect(() =>
      assertCommandAllowed(['backend/smoke'], parseArgs(['journal-append']))
    ).not.toThrow();
  });
});

describe('команды jobs и query', () => {
  it('jobs разбирается без аргументов', () => {
    expect(parseArgs(['jobs'])).toEqual({ kind: 'jobs', parent: '' });
  });

  it('jobs принимает папку', () => {
    expect(parseArgs(['jobs', 'folder'])).toEqual({ kind: 'jobs', parent: 'folder' });
  });

  it('query принимает текст ошибки и число дней', () => {
    expect(parseArgs(['query', 'текст ошибки', '90'])).toEqual({
      kind: 'query',
      fingerprint: 'текст ошибки',
      sinceDays: 90
    });
  });
});

describe('проверка аргументов runs query fetch source summary failures', () => {
  it('runs без джобы — ошибка использования', () => {
    expect(() => parseArgs(['runs'])).toThrow(/джобу/);
  });

  it('query дни и runs limit отвергают нецелое и неположительное', () => {
    expect(() => parseArgs(['query', 'x', 'abc'])).toThrow(/дней/);
    expect(() => parseArgs(['query', 'x', '0'])).toThrow(/дней/);
    expect(() => parseArgs(['runs', 'folder/example-job', 'abc'])).toThrow(/limit/);
    expect(() => parseArgs(['runs', 'folder/example-job', '0'])).toThrow(/limit/);
  });

  it('limit выше runListMax — ошибка использования', () => {
    expect(() => parseArgs(['runs', 'folder/example-job', '9999'])).toThrow(
      /limits\.runListMax/
    );
  });

  it('Лишние токены после fetch source runs summary failures — ошибка использования', () => {
    expect(() => parseArgs(['fetch', 'folder/example-job', '1', '--foo'])).toThrow(/Неизвестный аргумент/);
    expect(() => parseArgs(['source', 'folder/example-job', '1', 'A', 'extra'])).toThrow(
      /Неизвестный аргумент/
    );
    expect(() => parseArgs(['runs', 'folder/example-job', '5', 'extra'])).toThrow(/Неизвестный аргумент/);
    expect(() => parseArgs(['summary', 'folder/example-job', '1', 'extra'])).toThrow(
      /Неизвестный аргумент/
    );
    expect(() => parseArgs(['failures', 'folder/example-job', '1', 'extra'])).toThrow(
      /Неизвестный аргумент/
    );
  });

  it('failures без джобы называет отсутствующую джобу', () => {
    expect(() => parseArgs(['failures', '--recovered'])).toThrow(/джобу/);
    expect(() => parseArgs(['failures'])).toThrow(/джобу/);
  });
});




describe('Обязательный номер билда', () => {
  it('Команда с билдом отвергает отсутствующий или нецелый номер', () => {
      expect(() => parseArgs(['failures', 'backend/job', '--recovered'])).toThrow(/билд/);
      expect(() => parseArgs(['summary', 'backend/job'])).toThrow(/билд/);
      expect(() => parseArgs(['fetch', 'backend/job', 'abc'])).toThrow(/билд/);
      expect(() => parseArgs(['source', 'backend/job', '1.5', 'A'])).toThrow(/билд/);
    });
});


describe('Проверка значений аргументов', () => {
  it('Неположительный номер билда — ошибка использования', () => {
      expect(() => parseArgs(['fetch', 'folder/example-job', '0'])).toThrow(/билд/);
      expect(() => parseArgs(['summary', 'folder/example-job', '-1'])).toThrow(/билд/);
    });

  it('Лишние токены после record-runs jobs query journal-append init update repair — ошибка использования', () => {
      expect(() => parseArgs(['record-runs', 'job', 'extra'])).toThrow(/Неизвестный аргумент/);
      expect(() => parseArgs(['jobs', 'folder', 'extra'])).toThrow(/Неизвестный аргумент/);
      expect(() => parseArgs(['query', 'текст', '5', 'extra'])).toThrow(/Неизвестный аргумент/);
      expect(() => parseArgs(['journal-append', 'extra'])).toThrow(/Неизвестный аргумент/);
      expect(() => parseArgs(['init', 'extra'])).toThrow(/Неизвестный аргумент/);
      expect(() => parseArgs(['update', 'extra'])).toThrow(/Неизвестный аргумент/);
      expect(() => parseArgs(['repair', 'extra'])).toThrow(/repair/);
    });

  it('--profile и --config не принимают следующий флаг как значение', () => {
      expect(() => extractConfigFlag(['--profile', '--json', 'config'])).toThrow(/--profile/);
      expect(() => extractConfigFlag(['--config', '--out-dir', 'config'])).toThrow(/--config/);
    });

  it('--out-dir и --window-days не принимают следующий флаг как значение', () => {
      expect(() => parseArgs(['report', '--out-dir', '--window-days'])).toThrow(/--out-dir/);
      expect(() => parseArgs(['report', '--window-days', '--out-dir'])).toThrow(/--window-days/);
    });

  it('--window-days отвергает недесятичную и нецелую запись', () => {
      expect(() => parseArgs(['report', '--window-days', '1e2'])).toThrow(/--window-days/);
      expect(() => parseArgs(['report', '--window-days', '0x10'])).toThrow(/--window-days/);
      expect(() => parseArgs(['report', '--window-days', '1.5'])).toThrow(/--window-days/);
      expect(() => parseArgs(['report', '--window-days', '0'])).toThrow(/--window-days/);
    });

  it('config use с именем-флагом — ошибка', () => {
      expect(() => parseArgs(['config', 'use', '--json'])).toThrow(/--json/);
    });
});
