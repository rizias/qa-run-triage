import type { JenkinsClient } from './client.js';
import { isPathAllowed } from '../access.js';
import { toJenkinsPath } from './paths.js';
import type { BuildMeta, JobItem, RunListItem } from './types.js';

export async function listRuns(
  client: JenkinsClient,
  job: string,
  limit = client.settings.runListDefault
): Promise<RunListItem[]> {
  const tree = `builds[number,result,timestamp,duration]{0,${limit}}`;
  const data = await client.getJson<{ builds?: RawBuild[] }>(
    `${toJenkinsPath(job)}/api/json?tree=${tree}`,
    job
  );
  return (data.builds ?? []).map((build) => ({
    number: build.number,
    result: build.result ?? null,
    timestamp: build.timestamp ?? 0,
    durationMs: build.duration ?? 0
  }));
}


export async function listAllRuns(
  client: JenkinsClient,
  job: string
): Promise<RunListItem[]> {
  const tree = 'builds[number,result,timestamp,duration]';
  const data = await client.getJson<{ builds?: RawBuild[] }>(
    `${toJenkinsPath(job)}/api/json?tree=${tree}`,
    job
  );
  return (data.builds ?? []).map((build) => ({
    number: build.number,
    result: build.result ?? null,
    timestamp: build.timestamp ?? 0,
    durationMs: build.duration ?? 0
  }));
}

function extractParameters(actions: RawBuildDetails['actions']): Record<string, string> {
  const parameters: Record<string, string> = {};
  for (const action of actions ?? []) {
    for (const parameter of action.parameters ?? []) {
      parameters[parameter.name] = String(parameter.value);
    }
  }
  return parameters;
}

function extractCommit(actions: RawBuildDetails['actions']): string | null {
  const revision = (actions ?? []).find((action) => action.lastBuiltRevision);
  return revision?.lastBuiltRevision?.SHA1 ?? null;
}

function extractSourceArchiveSha256(fingerprints: RawBuildDetails['fingerprints']): string | null {
  const sourceArchiveSha256 = (fingerprints ?? [])
    .find((fingerprint) =>
      fingerprint.fileName?.replaceAll('\\', '/').endsWith('/src.zip') ||
      fingerprint.fileName === 'src.zip'
    )
    ?.hash?.toLowerCase();
  return sourceArchiveSha256 && /^[0-9a-f]{64}$/.test(sourceArchiveSha256)
    ? sourceArchiveSha256
    : null;
}

export async function getBuildMeta(
  client: JenkinsClient,
  job: string,
  build: number
): Promise<BuildMeta> {
  const tree =
    'number,result,duration,timestamp,artifacts[relativePath],fingerprints[fileName,hash],' +
    'actions[parameters[name,value],lastBuiltRevision[SHA1]]';
  const raw = await client.getJson<RawBuildDetails>(
    `${toJenkinsPath(job)}/${build}/api/json?tree=${tree}`,
    job
  );
  return {
    number: raw.number,
    result: raw.result ?? null,
    timestamp: raw.timestamp ?? 0,
    durationMs: raw.duration ?? 0,
    artifacts: (raw.artifacts ?? []).map((artifact) => artifact.relativePath),
    parameters: extractParameters(raw.actions),
    commit: extractCommit(raw.actions),
    sourceArchiveSha256: extractSourceArchiveSha256(raw.fingerprints)
  };
}

export async function getLatestCompletedBuildMeta(
  client: JenkinsClient,
  job: string
): Promise<BuildMeta | null> {
  const runs = await listAllRuns(client, job);
  const latest = runs.find((run) => run.result !== null);
  return latest ? getBuildMeta(client, job, latest.number) : null;
}

export async function listJobs(
  client: JenkinsClient,
  parent = ''
): Promise<JobItem[]> {
  const prefix = parent ? `${toJenkinsPath(parent)}/` : '';
  const data = await client.getJson<{ jobs?: RawJob[] }>(
    `${prefix}api/json?tree=jobs[name,color,_class]`
  );
  const result: JobItem[] = [];
  for (const job of data.jobs ?? []) {
    const jobPath = parent ? `${parent}/${job.name}` : job.name;
    if (!isPathAllowed(client.allowedJobs, jobPath)) {
      continue;
    }
    const isFolder = (job._class ?? '').includes('folder.Folder');
    result.push({ path: jobPath, isFolder, color: job.color ?? null });
    if (isFolder) {
      result.push(...(await listJobs(client, jobPath)));
    }
  }
  return result;
}

interface RawJob {
  name: string;
  color?: string;
  _class?: string;
}

interface RawBuild {
  number: number;
  result?: string;
  timestamp?: number;
  duration?: number;
}

interface RawBuildDetails extends RawBuild {
  artifacts?: { relativePath: string }[];
  fingerprints?: { fileName?: string; hash?: string }[];
  actions?: {
    parameters?: { name: string; value: unknown }[];
    lastBuiltRevision?: { SHA1?: string };
  }[];
}
