import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { withFileLock } from '../src/lock.js';

async function waitFor(file: string, children: ChildProcess[]): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!existsSync(file)) {
    if (children.some((child) => child.exitCode !== null)) throw new Error('Дочерний процесс завершился до сигнала');
    if (Date.now() > deadline) throw new Error('Не получен сигнал дочернего процесса');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it('два процесса: задержанный читатель устаревшего замка не отбирает нового владельца', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lock-race-'));
  const lock = path.join(root, 'shared.lock');
  writeFileSync(lock, JSON.stringify({ pid: 2_147_483_647, startedAt: 1 }));
  const worker = path.join(root, 'worker.mjs');
  const module = pathToFileURL(path.resolve('src/lock.ts')).href;
  writeFileSync(worker, `
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const [root, name, moduleUrl] = process.argv.slice(2);
const lock = path.join(root, 'shared.lock');
const signal = (name) => fs.writeFileSync(path.join(root, name), '1');
const pause = (name) => {
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(path.join(root, name))) {
    if (Date.now() > deadline) throw new Error('Не дождались сигнала');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
};
const original = fs.readFileSync;
let delayed = false;
fs.readFileSync = function(file, ...args) {
  const value = original.call(this, file, ...args);
  if (name === 'a' && String(file) === lock && !delayed) {
    delayed = true;
    signal('a-read');
    pause('resume-a');
  }
  return value;
};
syncBuiltinESMExports();
const { withFileLock } = await import(moduleUrl);
signal(name + '-ready');
pause('start-' + name);
try {
  withFileLock(lock, () => {
    signal(name + '-entered');
    pause('release-' + name);
  }, { timeoutMs: name === 'b' ? 300 : 3000, pollMs: 5 });
  signal(name + '-done');
} catch {
  signal(name + '-blocked');
}
`);
  const children = ['a', 'b'].map((name) => fork(worker, [root, name, module], {
    silent: true, execArgv: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning']
  }));
  const exits = children.map((child) => once(child, 'exit'));
  try {
    await waitFor(path.join(root, 'a-ready'), children);
    await waitFor(path.join(root, 'b-ready'), children);
    writeFileSync(path.join(root, 'start-a'), '1');
    await waitFor(path.join(root, 'a-read'), children);
    writeFileSync(path.join(root, 'start-b'), '1');
    await waitFor(path.join(root, 'b-blocked'), [children[0]]);
    expect(existsSync(path.join(root, 'b-entered'))).toBe(false);
    writeFileSync(path.join(root, 'resume-a'), '1');
    await waitFor(path.join(root, 'a-entered'), [children[0]]);
    writeFileSync(path.join(root, 'release-a'), '1');
    expect(await Promise.all(exits)).toEqual([[0, null], [0, null]]);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(lock + '.takeover')).toBe(false);
  } finally {
    children.forEach((child) => { if (child.exitCode === null) child.kill(); });
    await Promise.allSettled(exits);
  }
}, 15000);

it('владелец не удаляет замок с другим токеном', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lock-owner-'));
  const lock = path.join(root, 'shared.lock');
  const replacement = { pid: process.pid, startedAt: 1, token: 'другой-владелец' };
  withFileLock(lock, () => writeFileSync(lock, JSON.stringify(replacement)));
  expect(JSON.parse(readFileSync(lock, 'utf8'))).toEqual(replacement);
});

it('перехватывает замок после падения владельца захвата', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lock-guard-'));
  const lock = path.join(root, 'shared.lock');
  const dead = JSON.stringify({ pid: 2_147_483_647, startedAt: 1, token: 'старый' });
  writeFileSync(lock, dead);
  writeFileSync(lock + '.takeover', dead);
  expect(withFileLock(lock, () => 'записано')).toBe('записано');
  expect(existsSync(lock + '.takeover')).toBe(false);
});
