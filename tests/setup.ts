import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, vi } from 'vitest';

const tempRoot = path.resolve('.test-tmp');
mkdirSync(tempRoot, { recursive: true });
const testTemp = mkdtempSync(path.join(tempRoot, 'triage-tests-'));
export const fakeHome = mkdtempSync(path.join(testTemp, 'home-'));

vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
vi.spyOn(os, 'tmpdir').mockReturnValue(testTemp);
vi.stubEnv('TMP', testTemp);
vi.stubEnv('TEMP', testTemp);
vi.stubEnv('TMPDIR', testTemp);
afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(testTemp, { recursive: true, force: true });
});
