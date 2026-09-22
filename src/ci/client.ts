import type { Settings } from '../settings.js';

export interface RunListItem {
  number: number;
  result: string | null;
  timestamp: number;
  durationMs: number;
}

export interface SourceFreshness {
  isCurrent: boolean | null;
  runCommit: string | null;
  latestBuildCommit: string | null;
  warning: string | null;
}

export interface BuildMeta {
  number: number;
  result: string | null;
  timestamp: number;
  durationMs: number;
  artifacts: string[];
  parameters: Record<string, string>;
  commit: string | null;
  sourceArchiveSha256?: string | null;
  sourceFreshness?: SourceFreshness;
  workspaceNode?: number | null;
  checkouts?: { repository: string; commit: string }[];
}

export interface JobItem {
  path: string;
  isFolder: boolean;
  color: string | null;
}

export interface CiClient {
  readonly allowedJobs: readonly string[];
  readonly settings: Settings;
  readonly workspaceNodeMax: number;
  listJobs(parent?: string): Promise<JobItem[]>;
  listRuns(job: string, limit?: number): Promise<RunListItem[]>;
  listAllRuns(job: string): Promise<RunListItem[]>;
  getBuildMeta(job: string, build: number): Promise<BuildMeta>;
  getLatestCompletedBuildMeta(job: string): Promise<BuildMeta | null>;
  downloadConsoleLog(job: string, build: number, destFile: string): Promise<number>;
  downloadArtifact(job: string, build: number, artifactPath: string, destFile: string): Promise<number>;
  findWorkspaceNode(job: string, build: number, preferredNode?: number): Promise<number | null>;
  downloadWorkspaceSource(
    job: string,
    build: number,
    node: number,
    destFile: string
  ): Promise<number | null>;
  buildUrl(job: string, build: number): string | null;
}
