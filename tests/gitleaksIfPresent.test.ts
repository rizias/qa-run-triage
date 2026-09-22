import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'gitleaks-if-present.mjs'
);

function run(env: NodeJS.ProcessEnv): { status: number | null; out: string } {
  const emptyPath = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-nopath-'));
  const result = spawnSync(process.execPath, [script], {
    env: { ...env, PATH: emptyPath, PATHEXT: '' },
    encoding: 'utf8'
  });
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

describe('Запуск проверки секретов', () => {
  it('завершается ошибкой, если gitleaks нет, и называет страницу установки', () => {
    const { status, out } = run({ ...process.env, QA_RUN_TRIAGE_SKIP_SECRET_SCAN: undefined });
    expect(status).not.toBe(0);
    expect(out).toMatch(/gitleaks/);
    expect(out).toMatch(/https:\/\/github.com\/gitleaks\/gitleaks/);
  });

  it('пропускает проверку при QA_RUN_TRIAGE_SKIP_SECRET_SCAN=1', () => {
    const { status, out } = run({ ...process.env, QA_RUN_TRIAGE_SKIP_SECRET_SCAN: '1' });
    expect(status).toBe(0);
    expect(out).toMatch(/QA_RUN_TRIAGE_SKIP_SECRET_SCAN=1/);
  });
});
