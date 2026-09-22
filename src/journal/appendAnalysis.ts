import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { assertJobAllowed } from '../access.js';
import { assertCachedServer } from '../fetcher/cacheServer.js';
import type { Config } from '../config.js';
import { listFailures } from '../digest/failures.js';
import { reportDir, runDir } from '../fetcher/cachePaths.js';
import { resolveServerNameForJobLenient } from '../serverResolution.js';
import type { BuildMeta } from '../ci/client.js';
import { readMainRecords } from '../report/read.js';
import { createBuildUrl } from './buildUrl.js';
import { environmentFrom } from './environment.js';
import { appendEntry, type JournalEntryInput } from './journal.js';
import { ensureTestSet, readSourceHash } from './runRefs.js';

export const analysisShape = {
  job: z.string(),
  build: z.number().int().positive(),
  env: z.string().default(''),
  city: z.string().default(''),
  branch: z.string().default(''),
  codeBranch: z.string().default(''),
  result: z.string().nullable().default(null),
  testsRan: z.boolean(),
  total: z.number().int().nonnegative().nullable().default(null),
  failed: z.number().int().nonnegative().nullable().default(null),
  recoveredAfterRetry: z.number().int().nonnegative(),
  verdict: z.string(),
  fingerprints: z.array(z.string()).default([]),
  model: z.string().default(''),
  analysisDurationMs: z.number().int().nonnegative().default(0),
  buildTimestamp: z.number().nullable().optional(),
  durationMs: z.number().nullable().optional(),
  commit: z.string().nullable().optional(),
  buildUrl: z.string().nullable().optional(),
  tokensIn: z.number().int().nonnegative().default(0),
  tokensOut: z.number().int().nonnegative().default(0)
};

const analysisSchema = z.object(analysisShape).strict();

export type Analysis = z.infer<typeof analysisSchema>;

export function parseAnalysis(text: string): Analysis {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Вход не разбирается как JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  const parsed = analysisSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => formatAnalysisIssue(issue))
      .join('; ');
    throw new Error(`Разбор не проходит проверку: ${problems}`);
  }
  return parsed.data;
}

function formatAnalysisIssue(issue: z.ZodIssue): string {
  if (issue.code === z.ZodIssueCode.unrecognized_keys) {
    return `${issue.keys.join(', ')}: неизвестное поле`;
  }
  return `${issue.path.join('.') || 'корень'}: ${issue.message}`;
}

export function appendAnalysis(config: Config, entry: Analysis): void {
  assertJobAllowed(config.allowedJobs, entry.job);
  assertCachedServer(config, entry.job, entry.build);
  const meta = readOptionalMeta(config, entry.job, entry.build);
  const { testsRan, fingerprints } = resolveTestsRanAndFingerprints(config, entry);
  const environment = environmentFrom(meta?.parameters, config.environment);
  const serverName = resolveServerNameForJobLenient(
    config.jobs,
    config.defaultServer,
    Object.keys(config.servers),
    entry.job
  );

  appendEntry(config.cacheDir, {
    ...entry,
    testsRan,
    env: entry.env || environment.env,
    city: entry.city || environment.city,
    fingerprints,
    testSetHash: ensureTestSet(config.cacheDir, entry.job, entry.build),
    sourceHash: readSourceHash(config.cacheDir, entry.job, entry.build),
    ...metaDefaults(config, entry, meta, serverName),
    ...(serverName !== undefined ? { server: serverName } : {}),
    analyzedAt: new Date().toISOString()
  } satisfies JournalEntryInput, {
    timeoutMs: config.settings.journalLockTimeoutMs,
    pollMs: config.settings.journalLockPollMs
  });
}

function resolveTestsRanAndFingerprints(
  config: Config,
  entry: Analysis
): { testsRan: boolean; fingerprints: string[] } {
  if (!entry.testsRan) {
    return { testsRan: false, fingerprints: entry.fingerprints };
  }
  const report = reportDir(config.cacheDir, entry.job, entry.build);
  if (!existsSync(report)) {
    if (isLightweightSuccess(entry)) {
      return { testsRan: true, fingerprints: entry.fingerprints };
    }
    throw new Error('Прогон не скачан: сначала fetch');
  }
  const main = readMainRecords(report);
  if (main.length === 0) {
    return { testsRan: false, fingerprints: [] };
  }
  return {
    testsRan: true,
    fingerprints: [...new Set(listFailures(main, 'failed').map((failure) => failure.fingerprint))]
  };
}

function metaDefaults(
  config: Config,
  entry: Analysis,
  meta: BuildMeta | null,
  serverName: string | undefined
): Pick<JournalEntryInput, 'buildTimestamp' | 'durationMs' | 'commit' | 'buildUrl'> {
  return {
    buildTimestamp: entry.buildTimestamp === undefined ? meta?.timestamp ?? null : entry.buildTimestamp,
    durationMs: entry.durationMs === undefined ? meta?.durationMs ?? null : entry.durationMs,
    commit: entry.commit === undefined ? meta?.commit ?? null : entry.commit,
    buildUrl: entry.buildUrl === undefined
      ? createBuildUrl(config, serverName, entry.job, entry.build)
      : entry.buildUrl
  };
}

function isLightweightSuccess(entry: Analysis): boolean {
  return (
    entry.result === 'SUCCESS' &&
    entry.total === null &&
    entry.failed === null &&
    entry.fingerprints.length === 0
  );
}

function readOptionalMeta(config: Config, job: string, build: number): BuildMeta | null {
  const file = path.join(runDir(config.cacheDir, job, build), 'meta.json');
  if (!existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as BuildMeta;
  } catch (error) {
    throw new Error(
      `Файл ${file} не разбирается как JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}
