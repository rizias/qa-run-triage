import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  resolveProfileSelection,
  type ProfileSelection,
  type ProfileSource
} from './commonConfig.js';
import {
  CACHE_DIR_ENV_NAME,
  DEFAULT_ENVIRONMENT,
  fieldByName,
  notesFilePathForDir,
  resolveField,
  type CredentialsFile,
  type EnvironmentConfig,
  type FieldSource,
  type FieldValue,
  type JobGroupSpec,
  type ProfileFile
} from './configFields.js';
import { validateProfileFile } from './configValidation.js';
import { validateCredentialsFile } from './serverAuth.js';
import { isStringArray } from './jsonGuards.js';
import { buildServers, type ResolvedServer } from './serverResolution.js';
import { loadSettings, type Settings } from './settings.js';
import { parseJsonSafely, readSecretJson } from './secretJson.js';

export type { ProfileSource } from './commonConfig.js';
export type { FieldSource, JobGroupSpec } from './configFields.js';
export type { ResolvedServer } from './serverResolution.js';

export interface Config {
  readonly servers: Readonly<Record<string, ResolvedServer>>;
  readonly cacheDir: string;
  readonly jobs?: Readonly<Record<string, JobGroupSpec>>;
  readonly defaultServer?: string;
  readonly repos: readonly string[];
  readonly environment: EnvironmentConfig;
  readonly allowedJobs?: string[];
  readonly settings: Settings;
  readonly profileName: string;
  readonly profileSource: ProfileSource;
  readonly description: string;
  readonly profileFile: string;
  readonly profileFileFound: boolean;
  readonly credentialsFile: string;
}

export interface ProfileFileRead {
  readonly file: ProfileFile;
  readonly credentials: CredentialsFile;
  readonly path: string;
  readonly credentialsPath: string;
  readonly found: boolean;
  readonly selection: ProfileSelection;
}

function parseJsonFile(file: string, kind: string): unknown {
  return parseJsonSafely(file, readFileSync(file, 'utf8'), kind);
}

function assertServerReferences(
  file: ProfileFile,
  selection: ProfileSelection
): void {
  const serverNames = new Set(Object.keys(file.servers ?? {}));
  for (const [groupKey, group] of Object.entries(file.jobs ?? {})) {
    if (group.server !== undefined && !serverNames.has(group.server)) {
      throw new Error(
        `Файл профиля ${selection.profileFile}: поле jobs.${groupKey}.server ссылается на сервер ` +
          `"${group.server}", которого нет в servers.`
      );
    }
  }
  if (file.defaultServer !== undefined && !serverNames.has(file.defaultServer)) {
    throw new Error(
      `Файл профиля ${selection.profileFile}: поле defaultServer ссылается на сервер ` +
        `"${file.defaultServer}", которого нет в servers.`
    );
  }
  if (file.defaultServer === undefined && serverNames.size > 1) {
    throw new Error(
      `Файл профиля ${selection.profileFile}: поле defaultServer обязательно, когда servers содержит ` +
        'больше одной записи.'
    );
  }
}

export function readProfileFile(
  env: NodeJS.ProcessEnv = process.env,
  explicitConfigFile?: string,
  explicitProfile?: string,
  cwd?: string
): ProfileFileRead {
  const selection = resolveProfileSelection(env, explicitConfigFile, explicitProfile, cwd);
  if (!existsSync(selection.profileFile)) {
    if (selection.explicitFile || selection.source !== 'default') {
      throw new Error(`Файл профиля ${selection.profileFile} не найден.`);
    }
    return {
      file: {},
      credentials: {},
      path: selection.profileFile,
      credentialsPath: selection.credentialsFile,
      found: false,
      selection
    };
  }
  const file = validateProfileFile(parseJsonFile(selection.profileFile, 'профиля'), selection.profileFile);
  const credentials = existsSync(selection.credentialsFile)
    ? validateCredentialsFile(readSecretJson(selection.credentialsFile), selection.credentialsFile, file.servers ?? {}, env)
    : {};
  assertServerReferences(file, selection);
  return {
    file,
    credentials,
    path: selection.profileFile,
    credentialsPath: selection.credentialsFile,
    found: true,
    selection
  };
}

export function notesFilePath(selection: ProfileSelection): string {
  return notesFilePathForDir(selection.profileDir);
}

function asStringArray(value: FieldValue): string[] {
  if (!isStringArray(value)) {
    return [];
  }
  return value.map((job) => job.trim()).filter((job) => job.length > 0);
}

export interface CacheDirResolution {
  readonly value: string;
  readonly source: FieldSource;
}

export function resolveCacheDir(env: NodeJS.ProcessEnv, selection: ProfileSelection): CacheDirResolution {
  const override = env[CACHE_DIR_ENV_NAME];
  if (override !== undefined) {
    if (override.trim() === '') {
      throw new Error(`Переменная ${CACHE_DIR_ENV_NAME} задана пустым значением.`);
    }
    return { value: override, source: 'env' };
  }
  return { value: path.join(selection.profileDir, 'cache'), source: 'default' };
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  explicitConfigFile?: string,
  explicitProfile?: string,
  cwd?: string
): Config {
  const read = readProfileFile(env, explicitConfigFile, explicitProfile, cwd);
  return {
    servers: buildServers(env, read.file.servers, read.credentials),
    cacheDir: resolveCacheDir(env, read.selection).value,
    jobs: read.file.jobs,
    defaultServer: read.file.defaultServer,
    repos: read.file.repos ?? [],
    environment: read.file.environment ?? DEFAULT_ENVIRONMENT,
    allowedJobs: asStringArray(resolveField(fieldByName('allowedJobs'), env, read.file).value),
    settings: loadSettings(env, explicitConfigFile, explicitProfile, cwd),
    profileName: read.selection.profileName,
    profileSource: read.selection.source,
    description: typeof read.file.description === 'string' ? read.file.description : '',
    profileFile: read.path,
    profileFileFound: read.found,
    credentialsFile: read.credentialsPath
  };
}
