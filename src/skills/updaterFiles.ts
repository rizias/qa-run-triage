import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile } from '../lock.js';
import { assertSkillPaths, isSafeRelative } from './safePaths.js';
import {
  GLOBAL_SUFFIXES,
  KIND_BY_SUFFIX,
  PROJECT_SUFFIXES,
  samePath,
  toSlash,
  type AgentKind,
  type ChosenTarget,
  type TargetOption,
  type Templates
} from './updaterState.js';

const FRONTMATTER = /^---\n([\s\S]*?)\n---(?=\n|$)/;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const stampKey = (skill: string): string => `${skill}-skill-version`;

const normalizeDoc = (text: string): string => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

const readStamp = (text: string, skill: string): string | undefined => {
  const block = FRONTMATTER.exec(normalizeDoc(text));
  if (block === null) return undefined;
  const line = new RegExp(`^\\s*${escapeRegExp(stampKey(skill))}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, 'm').exec(block[1] ?? '');
  return line?.[1]?.trim();
};

const listFiles = (dir: string, prefix = ''): string[] => {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...listFiles(path.join(dir, entry.name), relative));
    else found.push(relative);
  }
  return found.sort();
};

const conflictMessage = (pkgName: string, dest: string, files: readonly string[]): string =>
  `${pkgName}: ${dest} не обновлён, потому что там уже есть файлы, не размещённые этой программой: ${files.join(', ')}. Это собственные файлы пользователя. Сообщите об этом конфликте пользователю и дайте ему решить, что делать с этими файлами.`;

const pathKey = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value);

const assertNoLinkedParents = (dest: string, relative: string): void => {
  const parts = relative.split('/');
  let current = dest;
  for (let i = 0; i < parts.length - 1; i += 1) {
    current = path.join(current, parts[i] ?? '');
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat !== undefined && stat.isSymbolicLink()) {
      throw new Error(`refusing to write through a link: ${current}`);
    }
  }
};

const collisions = (dest: string, template: string, recorded: readonly string[]): string[] => {
  if (!fs.existsSync(dest)) return [];
  const owned = new Set(recorded.map(pathKey));
  const shipped = new Set(listFiles(template).map(pathKey));
  return listFiles(dest).filter((relative) => shipped.has(pathKey(relative)) && !owned.has(pathKey(relative)));
};

const pruneEmptyDirs = (dest: string, relative: string): void => {
  let dir = path.dirname(path.join(dest, relative));
  const stop = path.resolve(dest);
  while (path.resolve(dir) !== stop) {
    try {
      fs.rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
};

const under = (base: string, suffixes: string[]): string[] =>
  suffixes.map((suffix) => path.join(base, ...suffix.split('/')));

const globalBases = (): string[] => under(os.homedir(), GLOBAL_SUFFIXES);

const projectBases = (projectDir: string): string[] => under(path.resolve(projectDir), PROJECT_SUFFIXES);

const kindOfBase = (base: string): AgentKind => {
  const asSlash = toSlash(base).replace(/\/+$/, '').toLowerCase();
  for (const [suffix, kind] of Object.entries(KIND_BY_SUFFIX)) {
    if (asSlash.endsWith(`/${suffix}`)) return kind;
  }
  return 'agents';
};

const customBase = (input: string): string => {
  const resolved = path.resolve(input);
  const asSlash = toSlash(resolved).replace(/\/+$/, '').toLowerCase();
  const isSkillsDir = GLOBAL_SUFFIXES.some((suffix) => asSlash.endsWith(`/${suffix}`));
  return isSkillsDir ? resolved : path.join(resolved, '.claude', 'skills');
};

const targetOptions = (projectDir: string): TargetOption[] => [
  { id: 'global', label: 'глобально (все агенты на этой машине)', roots: globalBases() },
  { id: 'project', label: 'только этот проект', roots: projectBases(projectDir) },
  { id: 'custom', label: 'свой путь', roots: [] },
];

const basesFor = (choice: ChosenTarget, projectDir: string): string[] => {
  if (choice.id === 'global') return globalBases();
  if (choice.id === 'project') return projectBases(projectDir);
  return choice.root === undefined ? [] : [customBase(choice.root)];
};

const templateRoots = (templates: Templates): string[] => {
  if (typeof templates === 'string') return [templates];
  return [templates.common, templates.claude, templates.codex, templates.agents]
    .filter((root): root is string => root !== undefined);
};

const hasSkillDoc = (dir: string): boolean =>
  fs.statSync(path.join(dir, 'SKILL.md'), { throwIfNoEntry: false })?.isFile() === true;

const resolveTemplate = (templates: Templates, kind: AgentKind, skill: string): string | undefined => {
  if (typeof templates === 'string') {
    const dir = path.join(templates, skill);
    return hasSkillDoc(dir) ? dir : undefined;
  }
  const roots = [templates[kind], templates.common].filter((root): root is string => root !== undefined);
  for (const root of roots) {
    const dir = path.join(root, skill);
    if (hasSkillDoc(dir)) return dir;
  }
  return undefined;
};

const scanSkills = (templates: Templates): string[] => {
  const names = new Set<string>();
  for (const root of templateRoots(templates)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && hasSkillDoc(path.join(root, entry.name))) names.add(entry.name);
    }
  }
  return [...names].sort();
};

const stampOf = (dir: string, skill: string): string | undefined => {
  try {
    return readStamp(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), skill);
  } catch {
    return undefined;
  }
};

const placeSkill = (template: string, dest: string, recorded: readonly string[]): void => {
  assertSkillPaths(dest, [...recorded, ...listFiles(template)]);
  if (samePath(toSlash(path.resolve(template)), toSlash(path.resolve(dest)))) {
    throw new Error(`template and destination are the same directory: ${dest}`);
  }
  if (!hasSkillDoc(template)) throw new Error(`template not found: ${template}`);
  fs.mkdirSync(dest, { recursive: true });
  const shipped = listFiles(template);
  const shippedKeys = new Set(shipped.map(pathKey));
  for (const relative of shipped) {
    if (relative === 'SKILL.md') continue;
    assertNoLinkedParents(dest, relative);
    const target = path.join(dest, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(template, relative), target);
  }
  for (const relative of recorded) {
    if (!isSafeRelative(relative) || shippedKeys.has(pathKey(relative))) continue;
    try {
      assertNoLinkedParents(dest, relative);
      fs.rmSync(path.join(dest, relative), { force: true });
      pruneEmptyDirs(dest, relative);
    } catch {
      continue;
    }
  }
  atomicWriteFile(
    path.join(dest, 'SKILL.md'),
    fs.readFileSync(path.join(template, 'SKILL.md'), 'utf8')
  );
};

export interface Job {
  skill: string;
  dest: string;
  kind: AgentKind;
}

export {
  basesFor,
  collisions,
  conflictMessage,
  isSafeRelative,
  kindOfBase,
  listFiles,
  placeSkill,
  resolveTemplate,
  scanSkills,
  stampOf,
  targetOptions
};
