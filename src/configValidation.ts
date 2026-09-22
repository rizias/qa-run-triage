import path from 'node:path';
import {
  SERVER_KINDS,
  CONFIG_FIELDS,
  SERVER_NAME_PATTERN,
  fieldByName,
  serverEnvName,
  type CommonFile,
  type EnvironmentConfig,
  type FieldSpec,
  type ProfileFile,
  type ServerSpec
} from './configFields.js';
import { isPlainObject, isStringArray } from './jsonGuards.js';
import { validateJobs } from './jobs.js';
import { assertReportArtifact } from './serverResolution.js';
import { parseAuthMode } from './serverAuth.js';
import { assertReportTimeZone } from './reportTimeZone.js';

function assertObjectRoot(parsed: unknown, kind: string, file: string): Record<string, unknown> {
  if (!isPlainObject(parsed)) throw new Error(`Файл ${kind} ${file} должен содержать объект JSON.`);
  return parsed;
}

export function validateCommonFile(parsed: unknown, file: string): CommonFile {
  const raw = assertObjectRoot(parsed, 'настроек', file);
  const result: CommonFile = {};
  for (const key of Object.keys(raw)) {
    if (key === 'profile') {
      if (typeof raw.profile !== 'string') {
        throw new Error(`Общий файл ${file}: поле profile должно быть строкой.`);
      }
      result.profile = raw.profile;
      continue;
    }
    if (key === 'bindings') {
      result.bindings = validateBindings(raw.bindings, file);
      continue;
    }
    throw new Error(`Общий файл ${file}: неизвестное поле ${key}.`);
  }
  return result;
}

function isAbsoluteBindingKey(folder: string): boolean {
  if (process.platform === 'win32') {
    return /^[A-Za-z]:[\\/]/.test(folder) || /^[\\/]{2}[^\\/]+[\\/]/.test(folder);
  }
  return path.posix.isAbsolute(folder);
}

function validateBindings(value: unknown, file: string): Record<string, string> {
  if (!isPlainObject(value)) {
    throw new Error(`Общий файл ${file}: поле bindings должно быть словарём «путь → профиль».`);
  }
  const result: Record<string, string> = {};
  for (const [folder, profile] of Object.entries(value)) {
    if (typeof profile !== 'string') {
      throw new Error(`Общий файл ${file}: значение bindings.${folder} должно быть строкой.`);
    }
    if (!isAbsoluteBindingKey(folder)) {
      throw new Error(`Общий файл ${file}: ключ bindings "${folder}" должен быть абсолютным путём.`);
    }
    result[folder] = profile;
  }
  return result;
}

export function validateProfileFile(parsed: unknown, file: string): ProfileFile {
  const raw = assertObjectRoot(parsed, 'профиля', file);
  const result: ProfileFile = {};
  for (const key of Object.keys(raw)) {
    if (key === 'description') {
      if (typeof raw.description !== 'string') {
        throw new Error(`Файл профиля ${file}: поле description должно быть строкой.`);
      }
      result.description = raw.description;
      continue;
    }
    if (key === 'servers') {
      result.servers = validateServers(raw.servers, file);
      continue;
    }
    if (key === 'jobs') {
      result.jobs = validateJobs(raw.jobs, file);
      continue;
    }
    if (key === 'defaultServer') {
      if (typeof raw.defaultServer !== 'string') {
        throw new Error(`Файл профиля ${file}: поле defaultServer должно быть строкой.`);
      }
      result.defaultServer = raw.defaultServer;
      continue;
    }
    if (key === 'repos') {
      result.repos = validateRepos(raw.repos, file);
      continue;
    }
    if (key === 'environment') {
      result.environment = validateEnvironment(raw.environment, 'environment', file);
      continue;
    }
    if (key === 'allowedJobs') {
      result.allowedJobs = validateFieldValue(fieldByName('allowedJobs'), raw.allowedJobs, file) as string[];
      continue;
    }
    if (key === 'limits' || key === 'report') {
      result[key] = validateSection(key, raw[key], file);
      continue;
    }
    throw new Error(`Файл профиля ${file}: неизвестное поле ${key}.`);
  }
  return result;
}

function validateServers(value: unknown, file: string): Record<string, ServerSpec> {
  if (!isPlainObject(value)) {
    throw new Error(`Файл профиля ${file}: поле servers должно быть словарём серверов.`);
  }
  const result: Record<string, ServerSpec> = Object.create(null) as Record<string, ServerSpec>;
  for (const [name, spec] of Object.entries(value)) {
    if (!SERVER_NAME_PATTERN.test(name)) {
      throw new Error(
        `Файл профиля ${file}: имя сервера "${name}" должно состоять из букв, цифр, дефиса и подчёркивания.`
      );
    }
    result[name] = validateServerSpec(name, spec, file);
  }
  assertUniqueServerEnvPrefixes(Object.keys(result), file);
  return result;
}

function assertUniqueServerEnvPrefixes(names: readonly string[], file: string): void {
  const byPrefix = new Map<string, string[]>();
  for (const name of names) {
    const prefix = serverEnvName(name, 'KIND');
    const group = byPrefix.get(prefix) ?? [];
    group.push(name);
    byPrefix.set(prefix, group);
  }
  for (const group of byPrefix.values()) {
    if (group.length < 2) {
      continue;
    }
    throw new Error(
      `Файл профиля ${file}: имена серверов ${group.map((name) => `"${name}"`).join(' и ')} ` +
        'дают один префикс переменных окружения.'
    );
  }
}

function validateServerSpec(name: string, value: unknown, file: string): ServerSpec {
  if (!isPlainObject(value)) {
    throw new Error(`Файл профиля ${file}: поле servers.${name} должно быть объектом.`);
  }
  const result: ServerSpec = {};
  for (const key of Object.keys(value)) {
    if (key === 'auth') {
      result.auth = parseAuthMode(value.auth, `servers.${name}.auth файла ${file}`);
      continue;
    }
    if (key === 'kind') {
      if (typeof value.kind !== 'string' || !SERVER_KINDS.includes(value.kind as (typeof SERVER_KINDS)[number])) {
        throw new Error(`Файл профиля ${file}: поле servers.${name}.kind должно быть одним из: ${SERVER_KINDS.join(', ')}.`);
      }
      result.kind = value.kind;
      continue;
    }
    if (key === 'baseUrl' || key === 'reportArtifact') {
      if (typeof value[key] !== 'string') {
        throw new Error(`Файл профиля ${file}: поле servers.${name}.${key} должно быть строкой.`);
      }
      result[key] = value[key];
      if (key === 'reportArtifact') assertReportArtifact(name, value[key]);
      continue;
    }
    if (key === 'workspaceNodeMax') {
      result.workspaceNodeMax = readWorkspaceNodeMax(name, value.workspaceNodeMax, file);
      continue;
    }
    throw new Error(`Файл профиля ${file}: неизвестное поле servers.${name}.${key}.`);
  }
  assertWorkspaceNodeKind(name, result, file);
  return result;
}

function readWorkspaceNodeMax(name: string, value: unknown, file: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Файл профиля ${file}: поле servers.${name}.workspaceNodeMax должно быть положительным целым числом.`);
  }
  return value;
}

function assertWorkspaceNodeKind(name: string, spec: ServerSpec, file: string): void {
  if (spec.workspaceNodeMax !== undefined && (spec.kind ?? SERVER_KINDS[0]) !== 'jenkins') {
    throw new Error(`Файл профиля ${file}: поле servers.${name}.workspaceNodeMax допустимо только для kind jenkins.`);
  }
}

function validateSection(section: string, value: unknown, file: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error(`Файл профиля ${file}: поле ${section} должно быть объектом.`);
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const spec = CONFIG_FIELDS.find((field) => field.name === `${section}.${key}`);
    if (!spec) {
      throw new Error(`Файл профиля ${file}: неизвестное поле ${section}.${key}.`);
    }
    result[key] = validateFieldValue(spec, value[key], file);
  }
  return result;
}

function validateFieldValue(spec: FieldSpec, value: unknown, file: string): unknown {
  if (spec.type === 'string') {
    return validateStringField(spec, value, file);
  }
  if (spec.type === 'number') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new Error(`Файл профиля ${file}: поле ${spec.name} должно быть положительным целым числом.`);
    }
    return value;
  }
  if (!isStringArray(value)) {
    throw new Error(`Файл профиля ${file}: поле ${spec.name} должно быть списком строк.`);
  }
  return value;
}

function validateStringField(spec: FieldSpec, value: unknown, file: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Файл профиля ${file}: поле ${spec.name} должно быть строкой.`);
  }
  if (spec.name === 'report.timeZone') assertReportTimeZone(value);
  if (spec.enum && !spec.enum.includes(value)) {
    throw new Error(`Файл профиля ${file}: поле ${spec.name} должно быть одним из: ${spec.enum.join(', ')}.`);
  }
  return value;
}

function validateRepos(value: unknown, file: string): string[] {
  if (!isStringArray(value)) {
    throw new Error(`Файл профиля ${file}: поле repos должно быть списком строк.`);
  }
  for (const repoPath of value) {
    if (!path.isAbsolute(repoPath)) {
      throw new Error(`Файл профиля ${file}: поле repos содержит не абсолютный путь "${repoPath}".`);
    }
  }
  return [...value];
}

const ENVIRONMENT_KEYS = ['env', 'city'] as const;

function validateEnvironment(value: unknown, fieldPath: string, file: string): EnvironmentConfig {
  if (!isPlainObject(value)) {
    throw new Error(`Файл профиля ${file}: поле ${fieldPath} должно быть словарём списков строк.`);
  }
  const result: Partial<Record<'env' | 'city', string[]>> = {};
  for (const key of Object.keys(value)) {
    if (!ENVIRONMENT_KEYS.includes(key as (typeof ENVIRONMENT_KEYS)[number])) {
      throw new Error(`Файл профиля ${file}: неизвестное поле ${fieldPath}.${key}.`);
    }
    const item = value[key];
    if (!isStringArray(item)) {
      throw new Error(`Файл профиля ${file}: поле ${fieldPath}.${key} должно быть списком строк.`);
    }
    result[key as 'env' | 'city'] = [...item];
  }
  return { env: result.env ?? ['env'], city: result.city ?? ['city'] };
}
