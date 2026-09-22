import { assertJobAllowed } from '../access.js';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runDir, sourceExtractedDir } from '../fetcher/cachePaths.js';
import { parseJsonText } from '../jsonFile.js';
import type { SourceFreshness } from '../ci/client.js';
import { toSourcePaths } from './testPath.js';

export interface TestSource {
  path: string;
  text: string;
  freshness: SourceFreshness;
}

interface RunManifest {
  source?: { sha256?: string } | null;
}

interface RunMeta {
  sourceFreshness?: SourceFreshness;
}

export function resolveInsideSourceRoot(sourceRoot: string, sourcePath: string): string {
  const root = path.resolve(sourceRoot);
  const target = path.resolve(root, sourcePath);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Путь исходника выходит за каталог исходников прогона: ${sourcePath}`);
  }
  return target;
}

export async function readTestSource(
  cacheDir: string,
  job: string,
  build: number,
  testClass: string,
  allowedJobs?: readonly string[]
): Promise<TestSource> {
  assertJobAllowed(allowedJobs, job);
  const manifestFile = path.join(runDir(cacheDir, job, build), 'manifest.json');
  const manifest = existsSync(manifestFile)
    ? parseJsonText(manifestFile, await readFile(manifestFile, 'utf8')) as RunManifest
    : {};
  const sha256 = manifest.source?.sha256;
  if (!sha256) {
    throw new Error(
      `У этого прогона ${job} #${build} исходники не архивировались, разбор возможен без них.`
    );
  }

  const sourceRoot = sourceExtractedDir(cacheDir, sha256);
  const sourcePaths = toSourcePaths(testClass);
  const matches = sourcePaths.filter((sourcePath) =>
    existsSync(resolveInsideSourceRoot(sourceRoot, sourcePath))
  );
  if (matches.length > 1) {
    throw new Error(
      `Исходник класса ${testClass} найден по двум путям: ${matches.join(', ')}.`
    );
  }
  if (matches.length === 0) {
    throw new Error(
      `Файл исходника не найден в исходниках прогона ${job} #${build}. Проверены пути: ${sourcePaths.join(', ')}.`
    );
  }

  const sourcePath = matches[0];
  const metaFile = path.join(runDir(cacheDir, job, build), 'meta.json');
  const meta = existsSync(metaFile)
    ? parseJsonText(metaFile, await readFile(metaFile, 'utf8')) as RunMeta
    : {};
  return {
    path: sourcePath,
    text: await readFile(resolveInsideSourceRoot(sourceRoot, sourcePath), 'utf8'),
    freshness: meta.sourceFreshness ?? {
      isCurrent: null,
      runCommit: null,
      latestBuildCommit: null,
      warning: null
    }
  };
}
