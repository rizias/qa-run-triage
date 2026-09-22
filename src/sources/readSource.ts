import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { assertJobAllowed } from '../access.js';
import { assertCachedServer } from '../fetcher/cacheServer.js';
import type { Config } from '../config.js';
import {
  ambiguousOneSegmentReason,
  matchStoredRepository,
  type Checkout
} from '../fetcher/checkouts.js';
import { runDir, sourceExtractedDir } from '../fetcher/cachePaths.js';
import { readTestSource, type TestSource } from './artifactRead.js';
import { readTestSourceFromRepo, type RepoSource } from './repoRead.js';

export type SourceAnswer = (TestSource & { origin: 'archive' }) | RepoSource;

export async function readSourceForRun(
  config: Config,
  job: string,
  build: number,
  testClass: string
): Promise<SourceAnswer> {
  assertJobAllowed(config.allowedJobs, job);
  assertCachedServer(config, job, build);
  if (archivedSourcesAvailable(config.cacheDir, job, build)) {
    const fromArchive = await readTestSource(config.cacheDir, job, build, testClass);
    return { ...fromArchive, origin: 'archive' };
  }
  const checkouts = readRunCheckouts(config.cacheDir, job, build);
  if (checkouts.length === 0) {
    throw new Error(
      `Коммит прогона ${job} #${build} неизвестен: его нет ни в кэше, ни в журнале. ` +
        `Прочитать код из репозитория не по чему.`
    );
  }
  return readFromCandidates(config.repos, checkouts, testClass);
}

function archivedSourcesAvailable(cacheDir: string, job: string, build: number): boolean {
  const manifestFile = path.join(runDir(cacheDir, job, build), 'manifest.json');
  if (!existsSync(manifestFile)) {
    return false;
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as {
      source?: { sha256?: string } | null;
    };
    const sha256 = manifest.source?.sha256;
    return Boolean(sha256) && existsSync(sourceExtractedDir(cacheDir, sha256!));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw new Error(
      `Не удалось прочитать манифест прогона ${job} #${build}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

interface RunMeta {
  checkouts?: Checkout[];
}

function readRunCheckouts(cacheDir: string, job: string, build: number): Checkout[] {
  const metaFile = path.join(runDir(cacheDir, job, build), 'meta.json');
  if (!existsSync(metaFile)) {
    return [];
  }
  try {
    const meta = JSON.parse(readFileSync(metaFile, 'utf8')) as RunMeta;
    return meta.checkouts ?? [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw new Error(
      `Не удалось прочитать meta.json прогона ${job} #${build}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

interface RepoOrigin {
  origin: string | null;
  reason: string | null;
}

function collectOrigins(repos: readonly string[]): Map<string, RepoOrigin> {
  const originByRepo = new Map<string, RepoOrigin>();
  for (const repoPath of repos) {
    originByRepo.set(repoPath, readOrigin(repoPath));
  }
  return originByRepo;
}

function tryCheckout(
  checkout: Checkout,
  repos: readonly string[],
  originByRepo: Map<string, RepoOrigin>,
  identities: readonly string[],
  testClass: string,
  hits: RepoSource[]
): string | null {
  const ambiguous = ambiguousOneSegmentReason(checkout.repository, identities);
  if (ambiguous) {
    return ambiguous;
  }
  let matchedClone = false;
  const reasons: string[] = [];
  for (const repoPath of repos) {
    const origin = originByRepo.get(repoPath)?.origin ?? null;
    if (!origin || !matchStoredRepository(checkout.repository, origin, identities)) {
      continue;
    }
    matchedClone = true;
    try {
      hits.push(readTestSourceFromRepo(repoPath, checkout.commit, testClass, checkout.repository));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'ошибка чтения клона';
      if (!reasons.includes(message)) {
        reasons.push(message);
      }
    }
  }
  return matchedClone ? (reasons.length > 0 ? reasons.join('; ') : null) : null;
}

function readFromCandidates(
  repos: readonly string[],
  checkouts: readonly Checkout[],
  testClass: string
): RepoSource {
  const originByRepo = collectOrigins(repos);
  const identities = repos.map((repoPath) => originByRepo.get(repoPath)?.origin ?? repoPath);
  const hits: RepoSource[] = [];
  const reasonByCheckout = new Map<Checkout, string | null>();
  for (const checkout of checkouts) {
    reasonByCheckout.set(
      checkout,
      tryCheckout(checkout, repos, originByRepo, identities, testClass, hits)
    );
  }
  if (hits.length === 1) {
    return hits[0];
  }
  if (hits.length > 1) {
    const names = [...new Set(hits.map((hit) => hit.repository))];
    throw new Error(
      `Файл найден в нескольких клонах: ${names.join(', ')}. Уточните репозиторий.`
    );
  }
  const summary = checkouts
    .map((checkout) => {
      const reason = reasonByCheckout.get(checkout) ?? null;
      return reason === null
        ? `${checkout.repository} (клон не найден в repos)`
        : `${checkout.repository} (клон найден: ${reason})`;
    })
    .join('; ');
  const repoReasons = [...originByRepo.values()]
    .map((info) => info.reason)
    .filter((reason): reason is string => Boolean(reason));
  const repoSuffix = repoReasons.length > 0 ? ` ${repoReasons.join(' ')}` : '';
  throw new Error(`Ни один клон не подходит для чтения. Репозитории прогона: ${summary}.${repoSuffix}`);
}

function readOrigin(repoPath: string): RepoOrigin {
  if (!existsSync(repoPath)) {
    return { origin: null, reason: `Путь из repos не найден: ${repoPath}.` };
  }
  if (!existsSync(path.join(repoPath, '.git'))) {
    return {
      origin: null,
      reason: `Путь из repos не является репозиторием git: ${repoPath}.`
    };
  }
  try {
    execFileSync('git', ['-C', repoPath, 'rev-parse', '--git-dir'], {
      stdio: ['ignore', 'ignore', 'ignore']
    });
  } catch (error) {
    return {
      origin: null,
      reason:
        `Путь из repos не является репозиторием git: ${repoPath}. ` +
        (error instanceof Error ? error.message : String(error))
    };
  }
  try {
    return {
      origin: execFileSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      }).trim(),
      reason: null
    };
  } catch (error) {
    return {
      origin: null,
      reason: `Не удалось прочитать origin клона ${repoPath}: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}
