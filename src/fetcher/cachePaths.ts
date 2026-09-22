import { createHash } from 'node:crypto';
import path from 'node:path';

export function toCacheKey(job: string): string {
  const parts = splitJob(job);
  const readable = parts
    .map((part) => part.replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/, ''))
    .join('_');
  const suffix = createHash('sha256').update(parts.join('/'), 'utf8').digest('hex').slice(0, 8);
  return `${readable}-${suffix}`;
}

function splitJob(job: string): string[] {
  const normalized = job.trim().replace(/^\/+|\/+$/g, '');
  const parts = normalized.split('/').filter((part) => part.length > 0);
  if (parts.length === 0) {
    throw new Error('Пустой путь джобы');
  }
  return parts;
}

export function runDir(cacheDir: string, job: string, build: number): string {
  return path.join(cacheDir, 'runs', toCacheKey(job), String(build));
}

export function reportDir(cacheDir: string, job: string, build: number): string {
  return path.join(runDir(cacheDir, job, build), 'report', 'allure-report');
}

export function sourcesByHashDir(cacheDir: string): string {
  return path.join(cacheDir, 'sources-by-hash');
}

export function sourceHashDir(cacheDir: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/i.test(sha256)) {
    throw new Error(`Некорректная SHA-256 исходников: ${sha256}`);
  }
  return path.join(sourcesByHashDir(cacheDir), sha256.toLowerCase());
}

export function sourceArchiveFile(cacheDir: string, sha256: string): string {
  return path.join(sourceHashDir(cacheDir, sha256), 'src.zip');
}

export function sourceExtractedDir(cacheDir: string, sha256: string): string {
  return path.join(sourceHashDir(cacheDir, sha256), 'extracted');
}

export function jobRunsDir(cacheDir: string, job: string): string {
  return path.join(cacheDir, 'runs', toCacheKey(job));
}
