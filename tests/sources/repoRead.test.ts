import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTestSourceFromRepo } from '../../src/sources/repoRead.js';
import { execFileSync } from 'node:child_process';

describe('Проверка коммита', () => {
  it('Коммит не SHA не передаётся git', () => {
      const repo = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-rf4-git-'));
      try {
        expect(() =>
          readTestSourceFromRepo(repo, '--output=/tmp/pwned', 'lib.ExampleTest', 'team/app')
        ).toThrow(/--output=\/tmp\/pwned/);
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });
});


describe('Передача ревизии git', () => {
  let repo: string;
  afterEach(() => { if (repo) rmSync(repo, { recursive: true, force: true }); });

  it('Ревизия после двойного минуса', () => {
      repo = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-rf4-git2-'));
      execFileSync('git', ['init', '-q', repo]);
      execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
      execFileSync('git', ['-C', repo, 'config', 'user.name', 'test']);
      mkdirSync(path.join(repo, 'src', 'test', 'java', 'lib'), { recursive: true });
      writeFileSync(
        path.join(repo, 'src', 'test', 'java', 'lib', 'ExampleTest.java'),
        'class ExampleTest {}\n'
      );
      execFileSync('git', ['-C', repo, 'add', '.']);
      execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'seed']);
      const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const source = readTestSourceFromRepo(repo, commit, 'lib.ExampleTest', 'team/app');
      expect(source.text).toMatch(/ExampleTest/);
      expect(source.commit).toBe(commit);
    });
});
