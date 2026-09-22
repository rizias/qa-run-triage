import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withFileLock } from '../src/lock.js';

function lockPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'qa-run-triage-lock-')), 'file.lock');
}

describe('withFileLock — сорванный замок', () => {
  it('Замок с мёртвым PID перехватывается', () => {
    const lockFile = lockPath();
    writeFileSync(lockFile, JSON.stringify({ pid: 2_147_483_647, startedAt: 1 }), 'utf8');
    const spy = vi.spyOn(process.stderr, 'write');
    try {
      const result = withFileLock(lockFile, () => 'ok', { timeoutMs: 200, pollMs: 20 });
      expect(result).toBe('ok');
      const text = spy.mock.calls.map((call) => String(call[0])).join('');
      expect(text).toContain(lockFile);
      expect(text).toContain('2147483647');
    } finally {
      spy.mockRestore();
    }
  });

  it('Замок с живым PID не перехватывается', () => {
    const lockFile = lockPath();
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), 'utf8');
    expect(() =>
      withFileLock(lockFile, () => 'ok', { timeoutMs: 80, pollMs: 20 })
    ).toThrow(/замок/);
  });

  it('Нечитаемый замок моложе таймаута не перехватывается', () => {
    const lockFile = lockPath();
    writeFileSync(lockFile, 'не JSON', 'utf8');
    expect(() =>
      withFileLock(lockFile, () => 'ok', { timeoutMs: 80, pollMs: 20 })
    ).toThrow(/замок/);
  });
});
