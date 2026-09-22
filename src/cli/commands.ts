import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import { assertPathAllowed } from '../access.js';
import { parseJsonText } from '../jsonFile.js';
import { createCiClient, buildRunUrl } from '../ci/createClient.js';
import type { BuildMeta } from '../ci/client.js';
import { fetchRun } from '../fetcher/fetchRun.js';
import { assertCachedServer } from '../fetcher/cacheServer.js';
import { reportDir, runDir } from '../fetcher/cachePaths.js';
import { countFingerprint } from '../journal/journal.js';
import { mainRecords, readAllureSummary, readTestCases } from '../report/read.js';
import { buildSummary } from '../digest/summary.js';
import { listFailures } from '../digest/failures.js';
import { readSourceForRun } from '../sources/readSource.js';
import { runInit, runUpdate } from '../skills/setup.js';
import {
  resolveServerNameForJob,
  resolveServerNameForJobLenient
} from '../serverResolution.js';
import { writeJournalReport } from '../htmlreport/report.js';
import { repairJournal } from '../journal/repair.js';
import { serverResolver } from '../journal/identity.js';
import { asRecordRunsResponse, recordRuns } from '../journal/recordRuns.js';
import type { Command } from './args.js';
import { runConfigInit } from './config/init.js';
import { runConfigProfiles } from './config/profiles.js';
import { runConfigShow } from './config/show.js';
import { runConfigUse } from './config/use.js';
import { runJournalAppend, readStandardInput } from './index.js';

function runConfigCommand(
  command: Extract<Command, { kind: 'config' }>,
  env: NodeJS.ProcessEnv,
  configFile: string | undefined,
  profile: string | undefined
): void {
  if (command.mode === 'init') {
    runConfigInit(env, configFile, profile);
    return;
  }
  if (command.mode === 'profiles') {
    runConfigProfiles(env, configFile, profile);
    return;
  }
  runConfigShow(env, configFile, profile, command.mode === 'json');
}

function clientForJob(
  config: Config,
  job: string
): { serverName: string; client: ReturnType<typeof createCiClient> } {
  const serverName = resolveServerNameForJob(
    config.jobs,
    config.defaultServer,
    Object.keys(config.servers),
    job
  );
  return { serverName, client: createCiClient(config, serverName) };
}

export async function runWithoutConfig(
  command: Command,
  env: NodeJS.ProcessEnv,
  configFile: string | undefined,
  profile: string | undefined
): Promise<boolean> {
  if (command.kind === 'init') {
    const report = await runInit();
    console.log(JSON.stringify(report, null, 2));
    return true;
  }
  if (command.kind === 'update') {
    process.exitCode = runUpdate();
    return true;
  }
  if (command.kind === 'config') {
    runConfigCommand(command, env, configFile, profile);
    return true;
  }
  if (command.kind === 'config-use') {
    runConfigUse(command.profile);
    return true;
  }
  return false;
}

function runQuery(config: Config, command: Extract<Command, { kind: 'query' }>): void {
  console.log(JSON.stringify(
    countFingerprint(config.cacheDir, command.fingerprint, command.sinceDays, config.allowedJobs, serverResolver(config)),
    null,
    2
  ));
}

async function runJournalAppendCommand(config: Config): Promise<void> {
  const input = await readStandardInput(config.settings.journalInputMaxBytes);
  console.log(JSON.stringify(await runJournalAppend(config, input), null, 2));
}

function runReport(config: Config, command: Extract<Command, { kind: 'report' }>): void {
  const output = writeJournalReport(config.cacheDir, {
    resolveServer: serverResolver(config),
    outDir: command.outDir,
    settings: config.settings,
    windowDays: command.windowDays
  });
  console.log(`Каталог HTML-отчёта сохранён: ${path.join(output, 'index.html')}`);
}

function runRepair(config: Config): void {
  const result = repairJournal(
    config.cacheDir,
    (job, build, savedServer) => {
      const serverName = savedServer ?? resolveServerNameForJobLenient(
        config.jobs,
        config.defaultServer,
        Object.keys(config.servers),
        job
      );
      const server = serverName ? config.servers[serverName] : undefined;
      if (!server?.baseUrl) {
        return null;
      }
      return buildRunUrl(server.kind, server.baseUrl, job, build);
    },
    console.warn,
    {
      resolveServer: serverResolver(config),
      baseUrl: (server) => config.servers[server]?.baseUrl,
      timeoutMs: config.settings.journalLockTimeoutMs,
      pollMs: config.settings.journalLockPollMs
    }
  );
  const reasons = Object.entries(result.skippedReasons)
    .map(([reason, count]) => `${reason}: ${count}`)
    .join(', ');
  console.log(
    `Починка завершена: обновлено ${result.updated}, обогащено ${result.enriched}, ` +
      `дублей удалено ${result.duplicatesRemoved}, пропущено ${result.skipped}` +
      (reasons ? ` (${reasons})` : '') +
      '.'
  );
}

async function runJobs(config: Config, command: Extract<Command, { kind: 'jobs' }>): Promise<void> {
  if (command.parent) {
    assertPathAllowed(config.allowedJobs, command.parent);
  }
  const { client } = clientForJob(config, command.parent);
  console.log(JSON.stringify(await client.listJobs(command.parent), null, 2));
}

async function runRuns(config: Config, command: Extract<Command, { kind: 'runs' }>): Promise<void> {
  const { client } = clientForJob(config, command.job);
  console.log(JSON.stringify(await client.listRuns(command.job, command.limit), null, 2));
}

async function runRecordRuns(config: Config, command: Extract<Command, { kind: 'record-runs' }>): Promise<void> {
  const { serverName, client } = clientForJob(config, command.job);
  console.log(
    JSON.stringify(asRecordRunsResponse(await recordRuns(client, config, serverName, command.job)), null, 2)
  );
}

async function runFetch(config: Config, command: Extract<Command, { kind: 'fetch' }>): Promise<void> {
  const { serverName, client } = clientForJob(config, command.job);
  console.log(
    JSON.stringify(
      await fetchRun(
        client,
        config,
        command.job,
        command.build,
        config.servers[serverName].reportArtifact,
        command.force
      ),
      null,
      2
    )
  );
}

async function runSource(config: Config, command: Extract<Command, { kind: 'source' }>): Promise<void> {
  console.log(
    JSON.stringify(
      { job: command.job, build: command.build, ...(await readSourceForRun(
        config,
        command.job,
        command.build,
        command.testClass
      )) },
      null,
      2
    )
  );
}

interface CachedRunData {
  meta: BuildMeta;
  cases: ReturnType<typeof readTestCases>;
  allure: ReturnType<typeof readAllureSummary> | null;
  hasReport: boolean;
}

function reportWasFetched(cacheDir: string, job: string, build: number): boolean {
  const manifestFile = path.join(runDir(cacheDir, job, build), 'manifest.json');
  if (!existsSync(manifestFile)) {
    return false;
  }
  const manifest = parseJsonText(manifestFile, readFileSync(manifestFile, 'utf8')) as {
    files?: { name: string }[];
  };
  return (manifest.files ?? []).some((file) => file.name.startsWith('report/'));
}

function loadCachedRun(
  config: Config,
  command: Extract<Command, { kind: 'summary' } | { kind: 'failures' }>
): CachedRunData {
  assertCachedServer(config, command.job, command.build);
  const metaFile = path.join(runDir(config.cacheDir, command.job, command.build), 'meta.json');
  if (!existsSync(metaFile)) {
    throw new Error(
      `Прогон ${command.job} #${command.build} не скачан. Выполните команду fetch.`
    );
  }
  const meta = parseJsonText(metaFile, readFileSync(metaFile, 'utf8')) as BuildMeta;
  const dir = reportDir(config.cacheDir, command.job, command.build);
  const hasReport = existsSync(dir);
  if (!hasReport && reportWasFetched(config.cacheDir, command.job, command.build)) {
    throw new Error(`В кэше нет записей тестов: ${dir}. Скачайте прогон заново.`);
  }
  const cases = hasReport ? readTestCases(dir) : [];
  const allure = hasReport ? readAllureSummary(dir) : null;
  return { meta, cases, allure, hasReport };
}

function runSummary(config: Config, command: Extract<Command, { kind: 'summary' }>): void {
  const { meta, cases, allure, hasReport } = loadCachedRun(config, command);
  console.log(
    JSON.stringify(
      buildSummary({ job: command.job, build: command.build, cases, allure, meta, hasReport }),
      null,
      2
    )
  );
}

function validateMainRecords(cases: Parameters<typeof mainRecords>[0], total: number): void {
  mainRecords(cases, total);
}

function runFailures(config: Config, command: Extract<Command, { kind: 'failures' }>): void {
  const { cases, allure } = loadCachedRun(config, command);
  if (allure) {
    validateMainRecords(cases, allure.statistic.total);
  }
  console.log(JSON.stringify(listFailures(cases, command.include), null, 2));
}

export const COMMAND_HANDLERS: Record<string, (config: Config, command: Command) => void | Promise<void>> = {
  query: (config, command) => runQuery(config, command as Extract<Command, { kind: 'query' }>),
  'journal-append': (config) => runJournalAppendCommand(config),
  report: (config, command) => runReport(config, command as Extract<Command, { kind: 'report' }>),
  repair: (config) => runRepair(config),
  jobs: (config, command) => runJobs(config, command as Extract<Command, { kind: 'jobs' }>),
  runs: (config, command) => runRuns(config, command as Extract<Command, { kind: 'runs' }>),
  'record-runs': (config, command) =>
    runRecordRuns(config, command as Extract<Command, { kind: 'record-runs' }>),
  fetch: (config, command) => runFetch(config, command as Extract<Command, { kind: 'fetch' }>),
  source: (config, command) => runSource(config, command as Extract<Command, { kind: 'source' }>),
  summary: (config, command) => runSummary(config, command as Extract<Command, { kind: 'summary' }>),
  failures: (config, command) => runFailures(config, command as Extract<Command, { kind: 'failures' }>)
};
