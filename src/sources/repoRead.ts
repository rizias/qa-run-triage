import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { toSourcePaths } from './testPath.js';

export interface RepoSource {
  path: string;
  text: string;
  origin: 'repository';
  repository: string;
  commit: string;
}

export function readTestSourceFromRepo(
  repoPath: string,
  commit: string,
  testClass: string,
  repository: string
): RepoSource {
  if (!existsSync(repoPath)) {
    throw new Error(`Каталог клона не найден: ${repoPath}.`);
  }
  assertGitCommit(commit);
  run(repoPath, ['rev-parse', '--git-dir'], `Путь ${repoPath} не является репозиторием git.`);
  run(
    repoPath,
    ['cat-file', '-e', '--', `${commit}^{commit}`],
    `Коммита ${commit} нет в локальном клоне ${repoPath}. Обновите клон и повторите.`
  );

  const candidates = toSourcePaths(testClass);
  const found = candidates.filter((candidate) => objectExists(repoPath, commit, candidate));
  if (found.length === 0) {
    throw new Error(
      `Файла нет в коммите ${commit}. Проверены пути: ${candidates.join(', ')}.`
    );
  }
  if (found.length > 1) {
    throw new Error(
      `Класс найден в обоих деревьях коммита ${commit}: ${found.join(' и ')}. Уточните имя.`
    );
  }
  return {
    path: found[0],
    text: run(repoPath, ['cat-file', '-p', '--', `${commit}:${found[0]}`], `Не удалось прочитать файл из коммита ${commit}.`),
    origin: 'repository',
    repository,
    commit
  };
}

function assertGitCommit(commit: string): void {
  if (/^[0-9a-f]{40}$/i.test(commit) || /^[0-9a-f]{64}$/i.test(commit)) {
    return;
  }
  throw new Error(`Коммит "${commit}" не является шестнадцатеричным SHA git.`);
}

function isMissingGitObject(error: unknown): boolean {
  const execError = error as { status?: number; stderr?: Buffer | string };
  if (execError.status === 1) {
    return true;
  }
  const stderr = Buffer.isBuffer(execError.stderr)
    ? execError.stderr.toString('utf8')
    : execError.stderr ?? '';
  return execError.status === 128 && /does not exist|Not a valid object name/i.test(stderr);
}

function objectExists(repoPath: string, commit: string, filePath: string): boolean {
  try {
    execFileSync('git', ['-C', repoPath, 'cat-file', '-e', '--', `${commit}:${filePath}`], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    return true;
  } catch (error) {
    if (isMissingGitObject(error)) {
      return false;
    }
    throw new Error(
      `Не удалось проверить файл ${filePath} в коммите ${commit} клона ${repoPath}.`,
      { cause: error }
    );
  }
}

function run(repoPath: string, args: string[], failureMessage: string): string {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    throw new Error(failureMessage, { cause: error });
  }
}
