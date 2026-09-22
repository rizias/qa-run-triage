import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { jobRunsDir } from './cachePaths.js';

export function pruneRuns(
  cacheDir: string,
  job: string,
  keep: number,
  skip?: (build: string) => boolean,
  fetchedBuild?: number
): string[] {
  const dir = jobRunsDir(cacheDir, job);
  if (!existsSync(dir)) {
    return [];
  }
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      /^\d+\.tmp-/.test(entry.name) &&
      !isActiveTemporaryDirectory(entry.name)
    ) {
      rmSync(path.join(dir, entry.name), { recursive: true, force: true });
    }
  }

  const builds = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => /^\d+$/.test(name))
    .filter((name) => !skip?.(name))
    .sort((left, right) => {
      if (Number(left) === fetchedBuild) return -1;
      if (Number(right) === fetchedBuild) return 1;
      return Number(right) - Number(left);
    });

  const extra = builds.slice(keep);
  const removed: string[] = [];
  for (const build of extra) {
    rmSync(path.join(dir, build), { recursive: true, force: true });
    removed.push(build);
  }
  return removed;
}

function isActiveTemporaryDirectory(name: string): boolean {
  const match = /^(\d+)\.tmp-(\d+)-\d+$/.exec(name);
  if (!match) {
    return false;
  }

  const pid = Number(match[2]);
  if (pid === process.pid) {
    return true;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return cause instanceof Error &&
      (cause as NodeJS.ErrnoException).code === 'EPERM';
  }
}
