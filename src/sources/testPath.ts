import path from 'node:path';

const SOURCE_ROOTS = ['src/main/java', 'src/test/java'] as const;
const TAIL_PATTERN = /^(.+):(\d+):\d+$/;

export interface SourceTail {
  path: string;
  line: number | null;
}

export function parseSourceTail(value: string): SourceTail {
  const titleSeparator = /#| › /.exec(value);
  if (titleSeparator) return { path: value.slice(0, titleSeparator.index), line: null };
  const match = TAIL_PATTERN.exec(value);
  if (!match) {
    return { path: value, line: null };
  }
  return { path: match[1], line: Number(match[2]) };
}

function hasDisallowedControl(identifier: string): boolean {
  for (const char of identifier) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code === 0x7F) {
      return true;
    }
  }
  return false;
}

function assertSafeSourceIdentifier(identifier: string): void {
  if (hasDisallowedControl(identifier)) {
    throw new Error(
      `Идентификатор исходника содержит управляющий символ и отвергнут: ${identifier}`
    );
  }
  if (identifier.includes('\\')) {
    throw new Error(
      `Идентификатор исходника содержит обратный слэш и отвергнут: ${identifier}`
    );
  }
  if (
    path.win32.isAbsolute(identifier) ||
    path.posix.isAbsolute(identifier) ||
    /^[A-Za-z]:/.test(identifier)
  ) {
    throw new Error(
      `Идентификатор исходника должен быть относительным путём без диска: ${identifier}`
    );
  }
}

function assertSafeRelativePath(relative: string): void {
  assertSafeSourceIdentifier(relative);
  const segments = relative.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(
      `Идентификатор исходника содержит пустой сегмент или "." или "..": ${relative}`
    );
  }
}

export function toSourcePaths(identifier: string): string[] {
  if (!identifier) {
    throw new Error('Пустое имя класса теста');
  }
  const stripped = parseSourceTail(identifier).path;
  assertSafeSourceIdentifier(stripped);
  if (stripped.includes('/') || /\.(?:[cm]?[jt]sx?)$/i.test(stripped)) {
    assertSafeRelativePath(stripped);
    return [stripped];
  }
  const outer = stripped.split('$')[0];
  const classPath = `${outer.split('.').join(path.posix.sep)}.java`;
  assertSafeRelativePath(classPath);
  return SOURCE_ROOTS.map((root) => {
    const joined = path.posix.join(root, classPath);
    assertSafeRelativePath(joined);
    return joined;
  });
}
