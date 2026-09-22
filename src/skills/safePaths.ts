import fs from 'node:fs';
import path from 'node:path';
import { GLOBAL_SUFFIXES, toSlash } from './updaterState.js';

export function isSafeRelative(relative: string): boolean {
  return relative !== '' && !/[\\:\p{Cc}]/u.test(relative)
    && relative.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function assertNoLinks(target: string): void {
  let current = path.resolve(target);
  for (;;) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Путь скилла проходит через ссылку: ${current}`);
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function assertSkillPaths(dest: string, files: readonly string[]): void {
  const portable = toSlash(dest);
  const resolved = path.resolve(dest);
  const base = toSlash(path.dirname(resolved)).toLowerCase();
  if (!path.isAbsolute(dest) || /\p{Cc}/u.test(dest)
    || portable.split('/').some((part) => part === '.' || part === '..')
    || !GLOBAL_SUFFIXES.some((suffix) => base.endsWith(`/${suffix}`))) {
    throw new Error(`Путь реестра вне ожидаемого каталога скиллов, пропущен: ${dest}`);
  }
  assertNoLinks(resolved);
  for (const relative of files) {
    if (!isSafeRelative(relative)) {
      throw new Error(`Небезопасный путь файла в реестре скиллов, пропущен: ${relative}`);
    }
    const target = path.resolve(resolved, relative);
    const within = path.relative(resolved, target);
    if (within.startsWith('..') || path.isAbsolute(within)) {
      throw new Error(`Файл вне каталога скилла, пропущен: ${relative}`);
    }
    assertNoLinks(target);
  }
}
