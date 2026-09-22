import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveProfileSelection, writeCommonFileProfile } from '../src/commonConfig.js';
import { commonFilePath, profileJsonPath } from '../src/configFields.js';
import { fakeHome } from './setup.js';
import { extractConfigFlag } from '../src/cli/args.js';
import { loadConfig } from '../src/config.js';

function writeProfileDir(name: string): string {
  const dir = path.join(fakeHome, '.qa-run-triage', 'profiles', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(profileJsonPath(name), '{}', 'utf8');
  return dir;
}

describe('resolveProfileSelection — привязки папок', () => {
  it('привязка не срабатывает на подстроку без границы сегмента пути', () => {
    writeProfileDir('bound');
    const project = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-project-'));
    const sibling = `${project}-other`;
    mkdirSync(sibling, { recursive: true });
    try {
      const selection = resolveProfileSelectionWithBindings(project, { [project]: 'bound' }, sibling);
      expect(selection.profileName).not.toBe('bound');
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('точное совпадение папки срабатывает', () => {
    writeProfileDir('exact');
    const project = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-project-'));
    try {
      const selection = resolveProfileSelectionWithBindings(project, { [project]: 'exact' }, project);
      expect(selection.profileName).toBe('exact');
      expect(selection.source).toBe('binding');
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  if (process.platform === 'win32') {
    it('на Windows сравнение путей без учёта регистра', () => {
      writeProfileDir('win-bound');
      const project = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-project-'));
      try {
        const selection = resolveProfileSelectionWithBindings(
          project.toUpperCase(),
          { [project.toUpperCase()]: 'win-bound' },
          project.toLowerCase()
        );
        expect(selection.profileName).toBe('win-bound');
      } finally {
        rmSync(project, { recursive: true, force: true });
      }
    });
  }
});

function resolveProfileSelectionWithBindings(
  _unused: string,
  bindings: Record<string, string>,
  cwd: string
): ReturnType<typeof resolveProfileSelection> {
  const commonDir = path.join(fakeHome, '.qa-run-triage');
  mkdirSync(commonDir, { recursive: true });
  const commonFile = path.join(commonDir, 'config.json');
  writeFileSync(commonFile, JSON.stringify({ profile: 'default', bindings }), 'utf8');
  try {
    return resolveProfileSelection({}, undefined, undefined, cwd);
  } finally {
    rmSync(commonFile, { force: true });
  }
}

describe('Запись текущего профиля', () => {
  it('создаёт общий файл, если его нет', () => {
    writeProfileDir('team-use');
    const commonPath = writeCommonFileProfile('team-use');
    try {
      expect(commonPath).toBe(commonFilePath());
      expect(JSON.parse(readFileSync(commonPath, 'utf8'))).toEqual({ profile: 'team-use' });
    } finally {
      rmSync(commonPath, { force: true });
    }
  });

  it('сохраняет bindings при смене профиля', () => {
    writeProfileDir('team-a');
    writeProfileDir('team-b');
    const commonPath = commonFilePath();
    mkdirSync(path.dirname(commonPath), { recursive: true });
    const bindingKey = process.platform === 'win32' ? 'C:\\x' : '/x';
    writeFileSync(commonPath, JSON.stringify({ profile: 'team-a', bindings: { [bindingKey]: 'team-a' } }), 'utf8');
    try {
      writeCommonFileProfile('team-b');
      expect(JSON.parse(readFileSync(commonPath, 'utf8'))).toEqual({
        profile: 'team-b',
        bindings: { [bindingKey]: 'team-a' }
      });
    } finally {
      rmSync(commonPath, { force: true });
    }
  });

  it('профиля для смены нет — ошибка с полным путём каталога, файл не создаётся', () => {
    const commonPath = commonFilePath();
    expect(existsSync(commonPath)).toBe(false);
    expect(() => writeCommonFileProfile('team-missing-use')).toThrow(
      new RegExp(path.join('profiles', 'team-missing-use').replace(/\\/g, '\\\\'))
    );
    expect(existsSync(commonPath)).toBe(false);
  });
});


describe('Проверка выбора профиля', () => {
  it('неизвестное поле общего файла называет поле и путь', () => {
    const file = commonFilePath();
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ servers: {} }));
    try {
      expect(() => resolveProfileSelection({}, undefined, undefined)).toThrow(`Общий файл ${file}: неизвестное поле servers.`);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('Ключ bindings на Windows без диска и UNC — ошибка', () => {
      if (process.platform !== 'win32') {
        return;
      }
      const commonDir = path.join(fakeHome, '.qa-run-triage');
      mkdirSync(commonDir, { recursive: true });
      const commonFile = path.join(commonDir, 'config.json');
      writeFileSync(
        commonFile,
        JSON.stringify({ profile: 'default', bindings: { '/home/me/project': 'default' } }),
        'utf8'
      );
      try {
        expect(() => resolveProfileSelection({}, undefined, undefined, commonDir)).toThrow(/\/home\/me\/project/);
      } finally {
        rmSync(commonFile, { force: true });
      }
    });

  it('Ключ bindings не абсолютный — ошибка называет ключ', () => {
      const commonDir = path.join(fakeHome, '.qa-run-triage');
      mkdirSync(commonDir, { recursive: true });
      const commonFile = path.join(commonDir, 'config.json');
      writeFileSync(commonFile, JSON.stringify({ profile: 'default', bindings: { 'relative/path': 'default' } }), 'utf8');
      try {
        expect(() => resolveProfileSelection({}, undefined, undefined, commonDir)).toThrow(/relative\/path/);
      } finally {
        rmSync(commonFile, { force: true });
      }
    });

  it('Пустой --profile и пустые переменные профиля и каталога данных — ошибка', () => {
      expect(extractConfigFlag(['summary', 'job', '1', '--profile', ''])).toEqual({
        configFile: undefined,
        profile: '',
        rest: ['summary', 'job', '1']
      });
      expect(() => resolveProfileSelection({}, undefined, '')).toThrow(/--profile/);
      expect(() => resolveProfileSelection({ QA_RUN_TRIAGE_PROFILE: '' }, undefined, undefined)).toThrow(
        /QA_RUN_TRIAGE_PROFILE/
      );
      expect(() => loadConfig({ QA_RUN_TRIAGE_CACHE_DIR: '' })).toThrow(/QA_RUN_TRIAGE_CACHE_DIR/);
    });
});


if (process.platform !== 'win32') describe('Права общего файла на POSIX', () => {
  function writeProfile(name: string, contents: Record<string, unknown>): void {
    const dir = path.join(fakeHome, '.qa-run-triage', 'profiles', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(profileJsonPath(name), JSON.stringify(contents), 'utf8');
  }

  it('config use сохраняет права 0600 у общего файла', () => {
        writeProfile('mode-profile', {});
        const commonPath = commonFilePath();
        mkdirSync(path.dirname(commonPath), { recursive: true });
        writeFileSync(commonPath, JSON.stringify({ profile: 'default' }), 'utf8');
        chmodSync(commonPath, 0o600);
        writeCommonFileProfile('mode-profile');
        expect(statSync(commonPath).mode & 0o777).toBe(0o600);
      });
});
