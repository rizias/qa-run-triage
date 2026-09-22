import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  PROFILE_NAME_PATTERN,
  commonFilePath,
  credentialsJsonPath,
  profileDir,
  profileJsonPath,
  type CommonFile
} from './configFields.js';
import { validateCommonFile } from './configValidation.js';
import { atomicWriteFile, withFileLock } from './lock.js';
import { parseJsonSafely } from './secretJson.js';

export type ProfileSource = 'flag' | 'env' | 'binding' | 'config' | 'default';

export interface ProfileSelection {
  readonly profileName: string;
  readonly source: ProfileSource;
  readonly profileDir: string;
  readonly profileFile: string;
  readonly credentialsFile: string;
  readonly explicitFile: boolean;
}

export interface CommonFileRead {
  readonly file: CommonFile;
  readonly path: string;
  readonly found: boolean;
}

export function validateProfileName(name: string): void {
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(
      `Имя профиля "${name}" должно начинаться с буквы или цифры и состоять из букв, цифр, дефиса и подчёркивания.`
    );
  }
}

export function readCommonFile(): CommonFileRead {
  const commonPath = commonFilePath();
  if (!existsSync(commonPath)) {
    return { file: {}, path: commonPath, found: false };
  }
  const parsed = parseJsonSafely(commonPath, readFileSync(commonPath, 'utf8'), 'настроек');
  return { file: validateCommonFile(parsed, commonPath), path: commonPath, found: true };
}

function normalizeForMatch(candidate: string): string {
  const resolved = path.resolve(candidate);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function matchesBoundary(cwd: string, folder: string): boolean {
  return cwd === folder || cwd.startsWith(folder.endsWith(path.sep) ? folder : `${folder}${path.sep}`);
}

function resolveBinding(bindings: Record<string, string> | undefined, cwd: string): string | undefined {
  if (!bindings) {
    return undefined;
  }
  const normalizedCwd = normalizeForMatch(cwd);
  let best: { profile: string; folderLength: number } | undefined;
  for (const [folder, profile] of Object.entries(bindings)) {
    const normalizedFolder = normalizeForMatch(folder);
    if (!matchesBoundary(normalizedCwd, normalizedFolder)) {
      continue;
    }
    if (!best || normalizedFolder.length > best.folderLength) {
      best = { profile, folderLength: normalizedFolder.length };
    }
  }
  return best?.profile;
}

function namedSelection(name: string, source: ProfileSource): ProfileSelection {
  return {
    profileName: name,
    source,
    profileDir: profileDir(name),
    profileFile: profileJsonPath(name),
    credentialsFile: credentialsJsonPath(name),
    explicitFile: false
  };
}

export function resolveProfileSelection(
  env: NodeJS.ProcessEnv,
  explicitConfigFile: string | undefined,
  explicitProfile: string | undefined,
  cwd: string = process.cwd()
): ProfileSelection {
  if (explicitConfigFile) {
    const resolvedFile = path.resolve(explicitConfigFile);
    const dir = path.dirname(resolvedFile);
    return {
      profileName: path.basename(dir),
      source: 'flag',
      profileDir: dir,
      profileFile: resolvedFile,
      credentialsFile: path.join(dir, 'credentials.json'),
      explicitFile: true
    };
  }
  if (explicitProfile !== undefined) {
    if (explicitProfile.trim() === '') {
      throw new Error('Флаг --profile задан пустым значением.');
    }
    validateProfileName(explicitProfile.trim());
    return namedSelection(explicitProfile.trim(), 'flag');
  }
  if (env.QA_RUN_TRIAGE_PROFILE !== undefined) {
    if (env.QA_RUN_TRIAGE_PROFILE.trim() === '') {
      throw new Error('Переменная QA_RUN_TRIAGE_PROFILE задана пустым значением.');
    }
    validateProfileName(env.QA_RUN_TRIAGE_PROFILE.trim());
    return namedSelection(env.QA_RUN_TRIAGE_PROFILE.trim(), 'env');
  }
  const common = readCommonFile();
  const boundName = resolveBinding(common.file.bindings, cwd)?.trim();
  if (boundName) {
    validateProfileName(boundName);
    return namedSelection(boundName, 'binding');
  }
  const configName = common.file.profile?.trim();
  if (configName) {
    validateProfileName(configName);
    return namedSelection(configName, 'config');
  }
  return namedSelection('default', 'default');
}

function atomicWriteJson(file: string, contents: unknown): void {
  atomicWriteFile(file, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
}

export function writeCommonFileProfile(name: string): string {
  validateProfileName(name);
  const dir = profileDir(name);
  if (!existsSync(dir)) {
    throw new Error(`Каталога профиля нет: ${dir}. Сначала создайте его командой config init --profile ${name}.`);
  }
  const commonPath = commonFilePath();
  withFileLock(`${commonPath}.lock`, () => {
    const current = readCommonFile().file;
    atomicWriteJson(commonPath, { ...current, profile: name });
  });
  return commonPath;
}
