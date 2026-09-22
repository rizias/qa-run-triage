import { mkdirSync, rmSync } from 'node:fs';
import type { Config } from '../config.js';
import { resolveServerNameForJob } from '../serverResolution.js';
import { assertJobAllowed } from '../access.js';
import type { CiClient } from '../ci/client.js';
import { runDir } from './cachePaths.js';
import { connectionIdentity } from './cacheServer.js';
import {
  downloadConsoleLog,
  pruneRunsWithoutLegacySourceDeletion,
  readCachedManifest,
  readPreviousMeta,
  resolveReport,
  resolveSource,
  writeMetaAndManifest
} from './fetchRunSteps.js';
import { promoteTempDir } from './promoteTempDir.js';

export const SOURCE_ARCHIVE = 'src.zip';
export const SOURCE_ARTIFACT_PATH = 'src/*zip*/src.zip';

export interface Manifest {
  serverIdentity?: string;
  server?: string;
  job: string;
  build: number;
  fetchedAt: string;
  files: { name: string; bytes: number }[];
  missing: { name: string; reason: string }[];
  source: { sha256: string } | null;
  testSet?: { sha256: string } | null;
}

export async function fetchRun(
  client: CiClient,
  config: Config,
  job: string,
  build: number,
  reportArtifact: string,
  force = false
): Promise<Manifest> {
  assertJobAllowed(config.allowedJobs, job);
  const finalDir = runDir(config.cacheDir, job, build);
  const server = resolveServerNameForJob(config.jobs, config.defaultServer, Object.keys(config.servers), job);
  const cached = await readCachedManifest(finalDir, job, build, force, server,
    connectionIdentity(server, config.servers[server].baseUrl));
  if (cached) {
    pruneRunsWithoutLegacySourceDeletion(config.cacheDir, job, config.settings.cacheKeepRuns, build);
    return cached;
  }

  const tempDir = `${finalDir}.tmp-${process.pid}-${Date.now()}`;
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });

  try {
    const files: { name: string; bytes: number }[] = [];
    const missing: { name: string; reason: string }[] = [];

    const meta = await client.getBuildMeta(job, build);
    const previousMeta = readPreviousMeta(finalDir);

    const checkouts = await downloadConsoleLog(client, job, build, tempDir, files);
    await resolveReport(
      client,
      job,
      build,
      reportArtifact,
      meta,
      tempDir,
      files,
      missing,
      config.settings.archiveMaxBytes
    );
    const resolution = await resolveSource(
      client,
      config,
      job,
      build,
      meta,
      previousMeta?.workspaceNode,
      tempDir,
      files,
      missing
    );

    const manifest = writeMetaAndManifest(
      tempDir,
      job,
      build,
      meta,
      resolution,
      checkouts,
      config,
      files,
      missing
    );

    promoteTempDir(tempDir, finalDir);

    pruneRunsWithoutLegacySourceDeletion(
      config.cacheDir,
      job,
      config.settings.cacheKeepRuns,
      build
    );
    return manifest;
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}
