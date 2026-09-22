import type { Config } from '../config.js';
import type { BuildMeta, CiClient, RunListItem } from '../ci/client.js';
import { createBuildUrl } from './buildUrl.js';
import { environmentFrom } from './environment.js';
import { fillMissingRunFields } from './backfill.js';
import {
  appendMissingEntries,
  readEntries,
  type JournalEntry,
  type JournalEntryInput,
  type JournalLockOptions
} from './journal.js';
import { ensureTestSet, readSourceHash } from './runRefs.js';
import { serverResolver } from './identity.js';
import { cachedRunMatches } from '../fetcher/cacheServer.js';

function lockOptions(config: Config): JournalLockOptions {
  return {
    resolveServer: serverResolver(config),
    timeoutMs: config.settings.journalLockTimeoutMs,
    pollMs: config.settings.journalLockPollMs
  };
}

export interface RunNeedingReview {
  number: number;
  result: string | null;
}

export interface RecordRunsResult {
  added: number;
  filledEnv: number;
  skippedAnalyzed: number;
  needsReview: RunNeedingReview[];
}

export interface RecordRunsResponse {
  'добавлено': number;
  'дозаполнено окружений': number;
  'разобрано ранее': number;
  'нужен разбор': RunNeedingReview[];
}

async function fillSavedEntryEnvironment(
  client: CiClient,
  config: Config,
  environmentConfig: Config['environment'],
  serverName: string,
  job: string,
  build: number,
  entry: JournalEntry
): Promise<boolean> {
  const needsEnv = entry.env.length === 0;
  if (!needsEnv && entry.city && entry.server && entry.buildUrl) {
    return false;
  }
  const parameters = needsEnv || !entry.city ? await readParameters(client, job, build) : {};
  const environment = environmentFrom(parameters, environmentConfig);
  return fillMissingRunFields(config.cacheDir, job, build, {
    env: environment.env,
    city: environment.city,
    buildUrl: createBuildUrl(config, serverName, job, build),
    server: serverName
  }, lockOptions(config));
}

async function buildSuccessEntry(
  client: CiClient,
  config: Config,
  environmentConfig: Config['environment'],
  serverName: string,
  job: string,
  analyzedAt: string,
  reportArtifact: string,
  run: RunListItem
): Promise<JournalEntryInput> {
  const meta = await readMeta(client, job, run.number);
  const parameters = meta?.parameters ?? {};
  const environment = environmentFrom(parameters, environmentConfig);
  const useCache = cachedRunMatches(config.cacheDir, job, run.number, serverName, config.servers[serverName].baseUrl);
  return {
    job,
    build: run.number,
    analyzedAt,
    env: environment.env,
    city: environment.city,
    branch: parameters.branch ?? '',
    codeBranch: parameters.code_branch ?? '',
    result: 'SUCCESS',
    testsRan: meta?.artifacts.includes(reportArtifact) ?? false,
    testSetHash: useCache ? ensureTestSet(config.cacheDir, job, run.number) : null,
    sourceHash: useCache ? readSourceHash(config.cacheDir, job, run.number) : null,
    total: null,
    failed: 0,
    recoveredAfterRetry: 0,
    verdict: 'прогон зелёный',
    fingerprints: [],
    buildTimestamp: run.timestamp,
    durationMs: run.durationMs,
    commit: meta?.commit ?? null,
    buildUrl: createBuildUrl(config, serverName, job, run.number),
    model: '',
    analysisDurationMs: 0,
    tokensIn: 0,
    tokensOut: 0,
    server: serverName
  };
}

export async function recordRuns(
  client: CiClient,
  config: Config,
  serverName: string,
  job: string
): Promise<RecordRunsResult> {
  const runs = await client.listAllRuns(job);
  const analyzedAt = new Date().toISOString();
  const environmentConfig = config.environment;
  const reportArtifact = config.servers[serverName].reportArtifact;
  const saved = new Map(
    readEntries(config.cacheDir)
      .entries.filter((entry) => normalizeJob(entry.job) === normalizeJob(job) && (entry.server ?? serverName) === serverName)
      .map((entry) => [entry.build, entry])
  );
  const successes: JournalEntryInput[] = [];
  let filledEnv = 0;

  for (const [build, entry] of saved) {
    const filled = await fillSavedEntryEnvironment(
      client,
      config,
      environmentConfig,
      serverName,
      job,
      build,
      entry
    );
    if (filled) {
      filledEnv += 1;
    }
  }

  for (const run of runs) {
    if (run.result !== 'SUCCESS' || saved.has(run.number)) {
      continue;
    }
    successes.push(
      await buildSuccessEntry(client, config, environmentConfig, serverName, job, analyzedAt, reportArtifact, run)
    );
  }

  let skippedAnalyzed = 0;
  const needsReview: RunNeedingReview[] = [];
  for (const run of runs) {
    if (run.result === 'SUCCESS') {
      continue;
    }
    const existing = saved.get(run.number);
    if (existing && existing.verdict.trim().length > 0) {
      skippedAnalyzed += 1;
      continue;
    }
    needsReview.push({ number: run.number, result: run.result });
  }

  return {
    added: appendMissingEntries(config.cacheDir, successes, lockOptions(config)),
    filledEnv,
    skippedAnalyzed,
    needsReview
  };
}

export function asRecordRunsResponse(result: RecordRunsResult): RecordRunsResponse {
  return {
    'добавлено': result.added,
    'дозаполнено окружений': result.filledEnv,
    'разобрано ранее': result.skippedAnalyzed,
    'нужен разбор': result.needsReview
  };
}

async function readMeta(
  client: CiClient,
  job: string,
  build: number
): Promise<BuildMeta | null> {
  try {
    return await client.getBuildMeta(job, build);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Адрес не найден:')) {
      return null;
    }
    throw error;
  }
}

async function readParameters(
  client: CiClient,
  job: string,
  build: number
): Promise<Record<string, string>> {
  return (await readMeta(client, job, build))?.parameters ?? {};
}
import { normalizeJob } from '../access.js';
