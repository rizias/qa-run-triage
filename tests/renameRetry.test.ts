import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const real = await vi.importActual<typeof import('node:fs')>('node:fs');
const renameSpy = vi.fn(real.renameSync);
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, renameSync: (...args: Parameters<typeof actual.renameSync>) => renameSpy(...args) };
});
const { renameWithRetry } = await import('../src/lock.js');

describe('Переименование с повтором', () => {
  afterEach(() => {
    renameSpy.mockReset();
    renameSpy.mockImplementation(real.renameSync);
  });

  it('повторяет переименование после временной ошибки EPERM', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'rename-retry-'));
    const from = path.join(root, 'from');
    const to = path.join(root, 'to');
    mkdirSync(from);
    writeFileSync(path.join(from, 'file.txt'), 'x');
    let failures = 2;
    renameSpy.mockImplementation((a, b) => {
      if (failures > 0) {
        failures -= 1;
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      }
      return real.renameSync(a, b);
    });
    renameWithRetry(from, to);
    expect(existsSync(path.join(to, 'file.txt'))).toBe(true);
    expect(renameSpy).toHaveBeenCalledTimes(3);
  });

  it('не повторяет переименование при постоянной ошибке другого вида', () => {
    renameSpy.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
    });
    expect(() => renameWithRetry('a', 'b')).toThrow(/ENOENT/);
    expect(renameSpy).toHaveBeenCalledTimes(1);
  });
});
