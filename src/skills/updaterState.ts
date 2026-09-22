import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile, withFileLock } from '../lock.js';

export type AgentKind = 'claude' | 'codex' | 'agents';

export type Templates = string | { common: string; claude?: string; codex?: string; agents?: string };

export type TargetId = 'global' | 'project' | 'custom';

export interface TargetOption {
  id: TargetId;
  label: string;
  roots: string[];
}

export interface ChosenTarget {
  id: TargetId;
  root?: string;
}

export interface Ask {
  chooseTargets(request: { skills: string[]; options: TargetOption[] }): Promise<ChosenTarget[]>;
  confirm(request: { message: string; paths: string[] }): Promise<boolean>;
}

export type SkipReason = 'foreign-files' | 'unavailable' | 'failed';

export interface SkippedPath {
  path: string;
  reason: SkipReason;
  files?: string[];
  message?: string;
}

export interface InstallReport {
  skills: string[];
  installed: string[];
  skipped: SkippedPath[];
  pruned: string[];
}

export interface RefreshReport {
  refreshed: string[];
  skipped: SkippedPath[];
}

export interface InstalledCopy {
  path: string;
  files: string[];
}

export interface RegistryEntry {
  version: string;
  skills: Record<string, InstalledCopy[]>;
  unavailable?: Record<string, number>;
}

export type Registry = Record<string, RegistryEntry>;

export interface InstallOptions {
  pkgName: string;
  version: string;
  templates: Templates;
  stateDir: string;
  ask: Ask;
  projectDir?: string;
}

export interface RefreshOptions {
  pkgName: string;
  version: string;
  templates: Templates;
  stateDir: string;
  quiet?: boolean;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

export const GLOBAL_SUFFIXES = ['.claude/skills', '.codex/skills', '.agents/skills'];
export const PROJECT_SUFFIXES = ['.claude/skills', '.agents/skills'];
export const KIND_BY_SUFFIX: Record<string, AgentKind> = {
  '.claude/skills': 'claude',
  '.codex/skills': 'codex',
  '.agents/skills': 'agents',
};
export const toSlash = (value: string): string => value.replace(/\\/g, '/');

export const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

export const findPathKey = (paths: Record<string, number>, target: string): string | undefined =>
  Object.keys(paths).find((key) => samePath(key, target));

export const note = (quiet: boolean | undefined, message: string): void => {
  if (quiet === true) return;
  process.stderr.write(`\x1b[2m${message}\x1b[0m\n`);
};

const registryPath = (stateDir: string): string => path.join(path.resolve(stateDir), 'skills-registry.json');

const readJsonFile = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return fallback;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Не удалось прочитать ${file}: ${message}`);
    throw new Error(`Файл ${file} не разбирается как JSON: ${message}`, { cause: error });
  }
};

const writeJsonFile = (file: string, value: unknown): void => {
  atomicWriteFile(file, JSON.stringify(value, null, 2));
};

export const readRegistry = (stateDir: string): Registry => readJsonFile<Registry>(registryPath(stateDir), {});

export const persistRegistry = (stateDir: string, registry: Registry): void => {
  writeJsonFile(registryPath(stateDir), registry);
};

export const withRegistryLock = <T>(stateDir: string, work: () => T): T =>
  withFileLock(`${registryPath(stateDir)}.lock`, work);

export const mutateRegistry = (stateDir: string, mutate: (registry: Registry) => void): void => {
  withRegistryLock(stateDir, () => {
    const registry = readRegistry(stateDir);
    mutate(registry);
    persistRegistry(stateDir, registry);
  });
};

export const recordInstall = (registry: Registry, pkgName: string, version: string, skill: string, dest: string, files: string[]): void => {
  const entry = registry[pkgName] ?? { version, skills: {} };
  const copies = (entry.skills[skill] ?? []).filter((copy) => !samePath(copy.path, toSlash(dest)));
  copies.push({ path: toSlash(dest), files: [...files].sort() });
  entry.skills[skill] = copies.sort((a, b) => a.path.localeCompare(b.path));
  entry.version = version;
  registry[pkgName] = entry;
};

export const recordedFiles = (registry: Registry, pkgName: string, skill: string, dest: string): string[] =>
  registry[pkgName]?.skills[skill]?.find((copy) => samePath(copy.path, toSlash(dest)))?.files ?? [];
