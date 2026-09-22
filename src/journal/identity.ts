import type { Config } from '../config.js';
import { normalizeJob } from '../access.js';
import { resolveServerNameForJobLenient } from '../serverResolution.js';

export type ResolveRunServer = (job: string) => string | undefined;
type Run = { job: string; build: number; server?: string };

export function serverResolver(config: Config): ResolveRunServer {
  return (job) => resolveServerNameForJobLenient(
    config.jobs, config.defaultServer, Object.keys(config.servers), job
  );
}

export function runKey(entry: Run, resolveServer?: ResolveRunServer): string {
  return JSON.stringify([entry.server ?? resolveServer?.(entry.job) ?? '', normalizeJob(entry.job), entry.build]);
}

export function sameRun(left: Run, right: Run, resolveServer?: ResolveRunServer): boolean {
  return runKey(left, resolveServer) === runKey(right, resolveServer);
}
