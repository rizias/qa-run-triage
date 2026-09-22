import { normalizeJob } from './access.js';
import type { JobGroupSpec } from './configFields.js';
import { isPlainObject } from './jsonGuards.js';

export interface JobSettings {
  readonly server?: string;
  readonly serverField: string;
}

export function resolveJobSettings(
  job: string,
  jobs: Readonly<Record<string, JobGroupSpec>> | undefined
): JobSettings {
  const groups = jobs ?? {};
  const bestKey = bestMatchKey(job, groups);
  const matched = bestKey === undefined ? undefined : groups[bestKey];
  return {
    server: matched?.server,
    serverField: bestKey === undefined ? 'defaultServer' : `jobs.${bestKey}.server`
  };
}

function normalizedJobKey(value: string): string {
  return normalizeJob(value).toLowerCase();
}

function jobMatchesKey(job: string, key: string): boolean {
  const normalizedJob = normalizedJobKey(job);
  const normalizedKey = normalizedJobKey(key);
  return normalizedJob === normalizedKey || normalizedJob.startsWith(`${normalizedKey}/`);
}

function bestMatchKey(
  job: string,
  groups: Readonly<Record<string, JobGroupSpec>>
): string | undefined {
  let bestKey: string | null = null;
  for (const key of Object.keys(groups)) {
    if (!jobMatchesKey(job, key)) {
      continue;
    }
    if (bestKey === null || normalizedJobKey(key).length > normalizedJobKey(bestKey).length) {
      bestKey = key;
    }
  }
  return bestKey === null ? undefined : bestKey;
}

export function validateJobs(value: unknown, file: string): Record<string, JobGroupSpec> {
  if (!isPlainObject(value)) {
    throw new Error(`Файл профиля ${file}: поле jobs должно быть словарём групп джоб.`);
  }
  const result: Record<string, JobGroupSpec> = {};
  for (const key of Object.keys(value)) {
    if (key === '*') {
      throw new Error(
        `Файл профиля ${file}: поле jobs.* недопустимо: ключ "*" не является особым и не должен совпадать буквально.`
      );
    }
    result[key] = validateJobGroup(value[key], `jobs.${key}`, file);
  }
  return result;
}

function validateJobGroup(value: unknown, fieldPath: string, file: string): JobGroupSpec {
  if (!isPlainObject(value)) {
    throw new Error(`Файл профиля ${file}: поле ${fieldPath} должно быть объектом.`);
  }
  const result: JobGroupSpec = {};
  for (const key of Object.keys(value)) {
    if (key === 'server') {
      if (typeof value.server !== 'string') {
        throw new Error(`Файл профиля ${file}: поле ${fieldPath}.server должно быть строкой.`);
      }
      result.server = value.server;
      continue;
    }
    throw new Error(`Файл профиля ${file}: неизвестное поле ${fieldPath}.${key}.`);
  }
  if (result.server === undefined) {
    throw new Error(`Файл профиля ${file}: поле ${fieldPath}.server обязательно.`);
  }
  return result;
}
