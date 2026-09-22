import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

it('после отдельного прогона удаляются фиктивный дом и все временные каталоги теста', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cleanup-probe-'));
  const result = path.join(root, 'result.json');
  const config = path.join(root, 'vitest.config.mjs');
  writeFileSync(config, `export default ${JSON.stringify({
    root,
    cacheDir: path.join(root, 'vite-cache'),
    test: { include: ['probe.test.ts'], setupFiles: [path.resolve('tests/setup.ts')] }
  })};`);
  writeFileSync(path.join(root, 'probe.test.ts'), `
import { it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
it('создаёт принадлежащие тесту каталоги', () => {
  const created = mkdtempSync(path.join(os.tmpdir(), 'owned-'));
  writeFileSync(process.env.CLEANUP_RESULT, JSON.stringify([os.homedir(), os.tmpdir(), created]));
});
`);
  const output: string[] = [];
  const child = spawn(process.execPath, [path.resolve('node_modules/vitest/vitest.mjs'), 'run', '--config', config], {
    env: { ...process.env, CLEANUP_RESULT: result }, stdio: 'pipe', windowsHide: true
  });
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  expect(code, output.join('')).toBe(0);
  const paths = JSON.parse(readFileSync(result, 'utf8')) as string[];
  expect(paths).toHaveLength(3);
  for (const owned of paths) expect(existsSync(owned), owned).toBe(false);
}, 15000);
