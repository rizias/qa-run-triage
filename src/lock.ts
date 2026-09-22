import {
  renameSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface LockOptions {
  pollMs?: number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_MS = 20;

interface LockHolder {
  pid: number;
  startedAt: number;
  token?: string;
}

interface OwnedLock { handle: number; token: string }

export function withFileLock<T>(lockFile: string, work: () => T, options: LockOptions = {}): T {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  const owned = acquireLockHandle(lockFile, timeoutMs, pollMs, deadline);
  try {
    return work();
  } finally {
    closeSync(owned.handle);
    releaseOwnedLock(lockFile, owned.token);
  }
}

function acquireLockHandle(
  lockFile: string,
  timeoutMs: number,
  pollMs: number,
  deadline: number
): OwnedLock {
  for (;;) {
    try {
      return createLockFile(lockFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
      if (reclaimIfStale(lockFile)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Файл занят другим процессом: замок ${lockFile} не освободился за ${timeoutMs} мс.`,
          { cause: error }
        );
      }
      pause(pollMs);
    }
  }
}

function createLockFile(lockFile: string): OwnedLock {
  mkdirSync(path.dirname(lockFile), { recursive: true });
  const handle = openSync(lockFile, 'wx');
  const token = randomUUID();
  try {
    const payload = JSON.stringify({ pid: process.pid, startedAt: Date.now(), token });
    writeSync(handle, payload);
    return { handle, token };
  } catch (error) {
    closeSync(handle);
    releaseOwnedLock(lockFile, token);
    throw error;
  }
}

function reclaimIfStale(lockFile: string): boolean {
  const takeover = `${lockFile}.takeover`;
  let guard: OwnedLock;
  try {
    guard = createLockFile(takeover);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const holder = readLockHolder(takeover);
      if (holder && !isPidAlive(holder.pid)) reclaimIfStale(takeover);
      return false;
    }
    throw error;
  }
  try {
    return removeStaleLock(lockFile);
  } finally {
    closeSync(guard.handle);
    releaseOwnedLock(takeover, guard.token);
  }
}

function removeStaleLock(lockFile: string): boolean {
  const holder = readLockHolder(lockFile);
  if (holder === null) {
    return false;
  }
  if (isPidAlive(holder.pid)) {
    return false;
  }
  const staleName = `${lockFile}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(lockFile, staleName);
  } catch {
    return false;
  }
  if (existsSync(staleName)) {
    unlinkSync(staleName);
  }
  process.stderr.write(`Замок ${lockFile} снят: процесс ${holder.pid} не существует.\n`);
  return true;
}

function readLockHolder(lockFile: string): LockHolder | null {
  try {
    const parsed = JSON.parse(readFileSync(lockFile, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0) {
      return null;
    }
    if (typeof record.startedAt !== 'number') {
      return null;
    }
    return { pid: record.pid, startedAt: record.startedAt,
      ...(typeof record.token === 'string' ? { token: record.token } : {}) };
  } catch {
    return null;
  }
}

function releaseOwnedLock(lockFile: string, token: string): void {
  if (readLockHolder(lockFile)?.token === token) unlinkSync(lockFile);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function atomicWriteFile(
  file: string,
  contents: string,
  options: { mode?: number } = {}
): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    if (options.mode === undefined) {
      writeFileSync(temporary, contents, 'utf8');
    } else {
      writeFileSync(temporary, contents, { encoding: 'utf8', mode: options.mode });
    }
    renameWithRetry(temporary, file);
    if (options.mode !== undefined && process.platform !== 'win32') {
      chmodSync(file, options.mode);
    }
  } catch (error) {
    if (existsSync(temporary)) {
      unlinkSync(temporary);
    }
    throw error;
  }
}

function pause(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

const RETRIABLE = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY']);
const ATTEMPTS = 10;
const PAUSE_MS = 50;

export function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= ATTEMPTS || !RETRIABLE.has(code)) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, PAUSE_MS * attempt);
    }
  }
}
