import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: (command: string, args: readonly string[]) => {
    const spec = args.at(-1) ?? '';
    if (args.includes('rev-parse')) {
      return '.git\n';
    }
    if (args.includes('cat-file')) {
      const dash = args.indexOf('--');
      if (dash === -1 || dash !== args.length - 2) {
        throw new Error('expected -- before git object');
      }
      if (spec.includes('^{commit}')) {
        return '';
      }
    }
    if (command === 'git') {
      throw Object.assign(new Error('git lock'), {
        status: 128,
        stderr: 'fatal: Unable to create lock'
      });
    }
    throw new Error(`unexpected ${command}`);
  }
}));

const { readTestSourceFromRepo } = await import('../../src/sources/repoRead.js');

let repo: string;

afterEach(() => {
  if (repo) {
    rmSync(repo, { recursive: true, force: true });
  }
});

describe('Ошибки чтения исходника через git', () => {
  it('Сбой git при проверке файла в коммите не выдаётся как отсутствие файла', () => {
    repo = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-gitfail-'));
    try {
      readTestSourceFromRepo(repo, 'a'.repeat(40), 'lib.ExampleTest', 'team/backend-tests');
      throw new Error('ожидалась ошибка git');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/Не удалось проверить файл/);
      expect((error as Error).message).not.toMatch(/Файла нет в коммите/);
    }
  });
});
