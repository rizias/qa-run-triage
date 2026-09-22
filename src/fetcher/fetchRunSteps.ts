import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import { resolveServerNameForJob } from '../serverResolution.js';
import type { BuildMeta, CiClient, SourceFreshness } from '../ci/client.js';
import { jobRunsDir } from './cachePaths.js';
import { extractReport } from './extractZip.js';
import { parseCheckouts } from './checkouts.js';
import { pruneRuns } from './prune.js';
import { writeTestSet } from '../journal/runRefs.js';
import { cacheSources } from '../sources/sourceCache.js';
import { fetchWorkspaceSource } from '../sources/workspaceFetch.js';
import { SOURCE_ARCHIVE, SOURCE_ARTIFACT_PATH, type Manifest } from './fetchRun.js';
import { connectionIdentity } from './cacheServer.js';
import { normalizeJob } from '../access.js';

function parseJsonFile(file: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Файл ${file} не разбирается как JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

export async function readCachedManifest(
  finalDir: string,
  job: string,
  build: number,
  force: boolean,
  server: string,
  serverIdentity: string
): Promise<Manifest | null> {
  const manifestFile = path.join(finalDir, 'manifest.json');
  if (force || !existsSync(manifestFile)) {
    return null;
  }
  const raw = await readFile(manifestFile, 'utf8');
  const cached = parseJsonFile(manifestFile, raw) as Partial<Manifest>;
  if (
    typeof cached.job === 'string' && normalizeJob(cached.job) === normalizeJob(job) &&
    cached.build === build &&
    (cached.server === undefined || cached.server === server) &&
    (cached.serverIdentity === undefined || cached.serverIdentity === serverIdentity) &&
    Object.prototype.hasOwnProperty.call(cached, 'source')
  ) {
    return cached as Manifest;
  }
  return null;
}

export async function downloadConsoleLog(
  client: CiClient,
  job: string,
  build: number,
  tempDir: string,
  files: { name: string; bytes: number }[]
): Promise<ReturnType<typeof parseCheckouts>> {
  const logFile = path.join(tempDir, 'console.log');
  const logBytes = await client.downloadConsoleLog(job, build, logFile);
  files.push({ name: 'console.log', bytes: logBytes });
  return parseCheckouts(await readFile(logFile, 'utf8'));
}

async function downloadReport(
  client: CiClient,
  job: string,
  build: number,
  reportArtifact: string,
  tempDir: string,
  files: { name: string; bytes: number }[],
  missing: { name: string; reason: string }[],
  archiveMaxBytes: number
): Promise<void> {
  const archiveName = 'downloads/report.zip';
  const zipFile = path.join(tempDir, archiveName);
  mkdirSync(path.dirname(zipFile), { recursive: true });
  const zipBytes = await client.downloadArtifact(job, build, reportArtifact, zipFile);
  files.push({ name: archiveName, bytes: zipBytes });
  const extracted = await extractReport(
    zipFile,
    path.join(tempDir, 'report'),
    reportArtifact,
    archiveMaxBytes
  );
  files.push({ name: 'report/', bytes: extracted.bytesWritten });
  addSkippedEntries(missing, extracted.skipped, 'отчёта');
}

export async function resolveReport(
  client: CiClient,
  job: string,
  build: number,
  reportArtifact: string,
  meta: BuildMeta,
  tempDir: string,
  files: { name: string; bytes: number }[],
  missing: { name: string; reason: string }[],
  archiveMaxBytes: number
): Promise<void> {
  if (meta.artifacts.includes(reportArtifact)) {
    await downloadReport(
      client,
      job,
      build,
      reportArtifact,
      tempDir,
      files,
      missing,
      archiveMaxBytes
    );
    return;
  }
  missing.push({
    name: reportArtifact,
    reason: 'Прогон завершился до создания отчёта'
  });
}

export interface SourceResolution {
  source: Manifest['source'];
  sourceFreshness: SourceFreshness;
  workspaceNode: BuildMeta['workspaceNode'] | null;
}

export async function resolveSource(
  client: CiClient,
  config: Config,
  job: string,
  build: number,
  meta: BuildMeta,
  previousWorkspaceNode: BuildMeta['workspaceNode'] | null | undefined,
  tempDir: string,
  files: { name: string; bytes: number }[],
  missing: { name: string; reason: string }[]
): Promise<SourceResolution> {
  if (meta.artifacts.some((artifact) => artifact.startsWith('src/'))) {
    const cachedSource = await cacheSources(
      config.cacheDir,
      meta.sourceArchiveSha256 ?? null,
      (destFile) => client.downloadArtifact(job, build, SOURCE_ARTIFACT_PATH, destFile),
      config.settings.archiveMaxBytes
    );
    const prefix = `sources-by-hash/${cachedSource.sha256}`;
    files.push({ name: `${prefix}/${SOURCE_ARCHIVE}`, bytes: cachedSource.archiveBytes });
    files.push({ name: `${prefix}/extracted/`, bytes: cachedSource.extractedBytes });
    addSkippedEntries(missing, cachedSource.skipped, 'исходников');
    return {
      source: { sha256: cachedSource.sha256 },
      sourceFreshness: {
        isCurrent: true,
        runCommit: meta.commit,
        latestBuildCommit: meta.commit,
        warning: null
      },
      workspaceNode: previousWorkspaceNode ?? null
    };
  }

  let source: Manifest['source'] = null;
  let workspaceNode = previousWorkspaceNode ?? null;
  const sourceFreshness = await fetchWorkspaceSource(
    client,
    config.cacheDir,
    job,
    build,
    meta,
    previousWorkspaceNode ?? undefined,
    missing,
    files,
    (node) => { workspaceNode = node; },
    (value) => { source = value; },
    config.settings.archiveMaxBytes
  );
  return { source, sourceFreshness, workspaceNode };
}

export function writeMetaAndManifest(
  tempDir: string,
  job: string,
  build: number,
  meta: BuildMeta,
  resolution: SourceResolution,
  checkouts: ReturnType<typeof parseCheckouts>,
  config: Config,
  files: { name: string; bytes: number }[],
  missing: { name: string; reason: string }[]
): Manifest {
  const metaFile = path.join(tempDir, 'meta.json');
  writeFileSync(
    metaFile,
    JSON.stringify(
      { ...meta, sourceFreshness: resolution.sourceFreshness, workspaceNode: resolution.workspaceNode, checkouts },
      null,
      2
    ),
    'utf8'
  );
  files.push({ name: 'meta.json', bytes: statSync(metaFile).size });

  let testSet: Manifest['testSet'] = null;
  try {
    const testSetHash = writeTestSet(config.cacheDir, path.join(tempDir, 'report', 'allure-report'));
    testSet = testSetHash === null ? null : { sha256: testSetHash };
  } catch (error) {
    missing.push({
      name: 'test-set',
      reason: error instanceof Error ? error.message : String(error)
    });
  }

  const server = resolveServerNameForJob(config.jobs, config.defaultServer, Object.keys(config.servers), job);
  const manifest: Manifest = {
    server,
    serverIdentity: connectionIdentity(server, config.servers[server].baseUrl),
    job,
    build,
    fetchedAt: new Date().toISOString(),
    files,
    missing,
    source: resolution.source,
    testSet
  };
  writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

export function readPreviousMeta(finalDir: string): BuildMeta | null {
  const metaFile = path.join(finalDir, 'meta.json');
  if (!existsSync(metaFile)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(metaFile, 'utf8')) as BuildMeta;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Не удалось прочитать ${metaFile}: ${message}`);
    return null;
  }
}

export function pruneRunsWithoutLegacySourceDeletion(
  cacheDir: string,
  job: string,
  keepRuns: number,
  fetchedBuild?: number
): void {
  const runsRoot = jobRunsDir(cacheDir, job);
  pruneRuns(cacheDir, job, keepRuns, (build) =>
    existsSync(path.join(runsRoot, build, 'sources')),
    fetchedBuild
  );
}

function addSkippedEntries(
  missing: { name: string; reason: string }[],
  entries: string[],
  kind: string
): void {
  for (const entryName of entries) {
    missing.push({
      name: entryName,
      reason: `Запись архива ${kind} указывает за пределы каталога, пропущена (zip slip)`
    });
  }
}
