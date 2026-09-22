import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runConfigInit } from '../../src/cli/config/init.js';
import { runConfigProfiles } from '../../src/cli/config/profiles.js';
import { runConfigShow } from '../../src/cli/config/show.js';
import { runConfigUse } from '../../src/cli/config/use.js';
import { commonFilePath, credentialsJsonPath, profileJsonPath, buildDefaultProfileContents } from '../../src/configFields.js';
import { fakeHome } from '../setup.js';
import { commandLoadsProfileSettings } from '../../src/cli/args.js';
import { describeConfig } from '../../src/configDescribe.js';

function captureConsoleLog(work: () => void): string[] {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => {
    lines.push(line);
  };
  try {
    work();
  } finally {
    console.log = originalLog;
  }
  return lines;
}

const DEFAULT_LIMITS = {
  cacheKeepRuns: 20,
  reportWindowDays: 14,
  fingerprintLookbackDays: 30,
  requestTimeoutMs: 30_000,
  downloadTimeoutMs: 120_000,
  runListDefault: 20,
  runListMax: 50,
  journalLockTimeoutMs: 5_000,
  journalLockPollMs: 20,
  archiveMaxBytes: 2_147_483_648,
  journalInputMaxBytes: 1_048_576
};

describe('runConfigInit — раскладка по умолчанию', () => {
  it('создаёт общий файл, profile.json и credentials.json с полями по умолчанию', () => {
    runConfigInit({}, undefined, undefined);

    const commonPath = commonFilePath();
    expect(existsSync(commonPath)).toBe(true);
    expect(JSON.parse(readFileSync(commonPath, 'utf8'))).toEqual({ profile: 'default' });

    const profilePath = profileJsonPath('default');
    expect(existsSync(profilePath)).toBe(true);
    const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as Record<string, unknown>;
    expect(profile).toEqual({
      description: '',
      servers: { main: { kind: 'jenkins', auth: 'basic', reportArtifact: 'allure-report.zip' } },
      repos: [],
      environment: { env: ['env'], city: ['city'] },
      allowedJobs: [],
      report: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      limits: DEFAULT_LIMITS
    });
    expect(profile).not.toHaveProperty('jobs');
    expect(profile).not.toHaveProperty('defaultServer');
    expect(profile).not.toHaveProperty('ci');
    expect((profile.servers as Record<string, unknown>).main).not.toHaveProperty('baseUrl');

    const credentialsPath = credentialsJsonPath('default');
    expect(existsSync(credentialsPath)).toBe(true);
    expect(JSON.parse(readFileSync(credentialsPath, 'utf8'))).toEqual({});
  });

  it('повторный запуск не меняет существующие файлы и завершается без ошибки', () => {
    runConfigInit({}, undefined, undefined);
    const firstProfile = readFileSync(profileJsonPath('default'), 'utf8');
    const firstCommon = readFileSync(commonFilePath(), 'utf8');

    runConfigInit({}, undefined, undefined);

    expect(readFileSync(profileJsonPath('default'), 'utf8')).toBe(firstProfile);
    expect(readFileSync(commonFilePath(), 'utf8')).toBe(firstCommon);
  });

  if (process.platform !== 'win32') {
    it('создаёт файлы с правами 0600 на POSIX', () => {
      runConfigInit({}, undefined, undefined);

      expect(statSync(profileJsonPath('default')).mode & 0o777).toBe(0o600);
      expect(statSync(credentialsJsonPath('default')).mode & 0o777).toBe(0o600);
      expect(statSync(commonFilePath()).mode & 0o777).toBe(0o600);
    });
  }
});

describe('runConfigInit — явный путь через --config', () => {
  it('config init с --config — ошибка использования', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-config-init-'));
    const file = path.join(dir, 'profile.json');

    expect(() => runConfigInit({}, file, undefined)).toThrow(/--config/);
    expect(existsSync(file)).toBe(false);
  });
});

describe('профили', () => {
  it('config init --profile создаёт каталог профиля с profile.json и credentials.json, общий файл не меняет profile', () => {
    runConfigInit({}, undefined, undefined);
    runConfigInit({}, undefined, 'team-b-init');

    expect(existsSync(profileJsonPath('team-b-init'))).toBe(true);
    expect(existsSync(credentialsJsonPath('team-b-init'))).toBe(true);
    expect(JSON.parse(readFileSync(commonFilePath(), 'utf8'))).toEqual({ profile: 'default' });

    const logs = captureConsoleLog(() => runConfigShow({}, undefined, 'team-b-init', true));
    const description = JSON.parse(logs[0]) as {
      cacheDir: { source: string; value: string };
      notesFile: string;
    };
    expect(description.cacheDir).toMatchObject({
      source: 'default',
      value: path.join(fakeHome, '.qa-run-triage', 'profiles', 'team-b-init', 'cache')
    });
    expect(description.notesFile).toBe(
      path.join(fakeHome, '.qa-run-triage', 'profiles', 'team-b-init', 'notes.md')
    );
  });

  it('config profiles печатает default и созданные профили с описанием, отмечая выбранный', () => {
    runConfigInit({}, undefined, 'team-a');
    writeFileSync(
      profileJsonPath('team-a'),
      JSON.stringify({ description: 'Команда А' }),
      'utf8'
    );
    runConfigInit({}, undefined, 'team-b');

    const logs = captureConsoleLog(() => runConfigProfiles({}, undefined, 'team-b'));

    expect(logs.some((line) => line.startsWith('default'))).toBe(true);
    expect(logs.some((line) => line === 'team-a — Команда А')).toBe(true);
    expect(logs.some((line) => line.startsWith('team-b') && line.includes('выбран'))).toBe(true);
    expect(logs.some((line) => line.startsWith('team-a') && line.includes('выбран'))).toBe(false);
  });

  it('Сломанный соседний профиль не обрывает список', () => {
    runConfigInit({}, undefined, 'ok-profile');
    writeFileSync(profileJsonPath('ok-profile'), JSON.stringify({ description: 'годный' }), 'utf8');
    runConfigInit({}, undefined, 'broken-profile');
    writeFileSync(profileJsonPath('broken-profile'), '{не json', 'utf8');

    const logs = captureConsoleLog(() => runConfigProfiles({}, undefined, 'ok-profile'));

    expect(logs.some((line) => line.startsWith('ok-profile'))).toBe(true);
    expect(logs.some((line) => line.includes('broken-profile') && line.includes('не прочитано'))).toBe(
      true
    );
  });

  it('config --json --profile показывает путь файла заметок профиля', () => {
    runConfigInit({}, undefined, 'team-notes');

    const logs = captureConsoleLog(() => runConfigShow({}, undefined, 'team-notes', true));

    const description = JSON.parse(logs[0]) as { notesFile: string; notesFileFound: boolean };
    expect(description.notesFile).toBe(
      path.join(fakeHome, '.qa-run-triage', 'profiles', 'team-notes', 'notes.md')
    );
    expect(description.notesFileFound).toBe(false);
  });
});

describe('Смена текущего профиля', () => {
  it('переключает текущий профиль в общем файле', () => {
    runConfigInit({}, undefined, undefined);
    runConfigInit({}, undefined, 'team-use');

    runConfigUse('team-use');

    expect(JSON.parse(readFileSync(commonFilePath(), 'utf8'))).toEqual({ profile: 'team-use' });
    const logs = captureConsoleLog(() => runConfigShow({}, undefined, undefined, true));
    const description = JSON.parse(logs[0]) as { profileName: string; profileSource: string };
    expect(description.profileName).toBe('team-use');
    expect(description.profileSource).toBe('config');
  });

  it('профиля для смены нет — ошибка с полным путём каталога, общий файл не меняется', () => {
    runConfigInit({}, undefined, undefined);
    const before = readFileSync(commonFilePath(), 'utf8');

    expect(() => runConfigUse('team-does-not-exist')).toThrow(/team-does-not-exist/);

    expect(readFileSync(commonFilePath(), 'utf8')).toBe(before);
  });
});


describe('Управление профилями при сломанном указателе', () => {
  function writeProfile(name: string, contents: Record<string, unknown>): void {
    const dir = path.join(fakeHome, '.qa-run-triage', 'profiles', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(profileJsonPath(name), JSON.stringify(contents), 'utf8');
  }

  it('config use и config profiles работают при сломанном указателе текущего профиля', () => {
      expect(commandLoadsProfileSettings(['config', 'use', 'team-b'])).toBe(false);
      expect(commandLoadsProfileSettings(['config', 'profiles'])).toBe(false);
      expect(commandLoadsProfileSettings(['config', 'init'])).toBe(false);
      expect(commandLoadsProfileSettings(['config'])).toBe(true);
      const commonDir = path.join(fakeHome, '.qa-run-triage');
      mkdirSync(commonDir, { recursive: true });
      writeFileSync(path.join(commonDir, 'config.json'), JSON.stringify({ profile: 'missing-now' }), 'utf8');
      writeProfile('ok-profile', {});
      expect(() => runConfigProfiles({}, undefined, undefined)).not.toThrow();
      expect(() => runConfigUse('ok-profile')).not.toThrow();
    });
});


describe('Числовые пределы профиля', () => {
  it('config init записывает одиннадцать пределов включая archiveMaxBytes', () => {
      const limits = (buildDefaultProfileContents().limits ?? {}) as Record<string, number>;
      expect(Object.keys(limits)).toHaveLength(11);
      expect(limits.archiveMaxBytes).toBe(2_147_483_648);
      const shown = describeConfig({});
      const archive = shown.limits.find((field) => field.name === 'limits.archiveMaxBytes');
      expect(archive).toMatchObject({ value: 2_147_483_648, source: 'default' });
    });
});
