import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { assertJobAllowed } from '../access.js';
import { assertBaseUrl, maskUrlUserinfo, safeError } from '../safeUrl.js';
import type { BuildMeta, CiClient, JobItem, RunListItem } from '../ci/client.js';
import type { Settings } from '../settings.js';
import type { ServerAuthentication } from '../serverAuth.js';
import { toJenkinsPath, workspacePath, workspaceSourcePath } from './paths.js';
import {
  getBuildMeta as fetchBuildMeta,
  getLatestCompletedBuildMeta as fetchLatestCompletedBuildMeta,
  listAllRuns as fetchAllRuns,
  listJobs as fetchJobList,
  listRuns as fetchRunList
} from './queries.js';

export type JenkinsConnection = ServerAuthentication & {
  readonly baseUrl: string;
  readonly allowedJobs?: readonly string[];
  readonly settings: Settings;
  readonly workspaceNodeMax: number;
};

export class JenkinsClient implements CiClient {
  private readonly auth: string | undefined;

  constructor(
    private readonly config: JenkinsConnection,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    assertBaseUrl(config.baseUrl, 'baseUrl');
    if (config.auth !== 'none') {
      const pair = config.auth === 'token' ? `${config.user}:${config.token}` : `${config.proxyUser}:${config.proxyPass}`;
      this.auth = 'Basic ' + Buffer.from(pair).toString('base64');
    }
  }

  async getJson<T>(path: string, job?: string): Promise<T> {
    try {
      const response = await this.request(path, job);
      if (!response) {
        throw new Error(`Пустой ответ Jenkins на ${path}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      if (isTimeoutError(error)) {
        throw this.timeoutError('запроса', path, this.config.settings.requestTimeoutMs, error);
      }
      throw safeError(error);
    }
  }

  async download(path: string, destFile: string, job?: string): Promise<number> {
    const timeoutMs = this.config.settings.downloadTimeoutMs;
    try {
      const response = await this.request(path, job, [], timeoutMs, 'скачивания');
      if (!response) {
        throw new Error(`Пустой ответ Jenkins на ${path}`);
      }
      if (!response.body) {
        throw new Error(`Пустой ответ при скачивании ${path}`);
      }
      let bytes = 0;
      const source = Readable.fromWeb(response.body as never);
      source.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
      });
      await pipeline(source, createWriteStream(destFile));
      return bytes;
    } catch (error) {
      if (isTimeoutError(error)) {
        throw this.timeoutError('скачивания', path, timeoutMs, error);
      }
      throw safeError(error);
    }
  }

  async findWorkspaceNode(
    job: string,
    build: number,
    preferredNode?: number
  ): Promise<number | null> {
    if (preferredNode !== undefined) {
      const cached = await this.request(workspacePath(job, build, preferredNode), job, [404]);
      if (cached) {
        await cached.body?.cancel();
        return preferredNode;
      }
    }
    for (let node = 1; node <= this.config.workspaceNodeMax; node += 1) {
      const response = await this.request(workspacePath(job, build, node), job, [404]);
      if (response) {
        await response.body?.cancel();
        return node;
      }
    }
    return null;
  }

  async downloadWorkspaceSource(
    job: string,
    build: number,
    node: number,
    destFile: string
  ): Promise<number | null> {
    const requestPath = workspaceSourcePath(job, build, node);
    const timeoutMs = this.config.settings.downloadTimeoutMs;
    try {
      const response = await this.request(requestPath, job, [403, 404], timeoutMs, 'скачивания');
      if (!response) {
        return null;
      }
      if (!response.body) {
        throw new Error(`Пустой ответ при скачивании исходников ${job} #${build}`);
      }
      let bytes = 0;
      const source = Readable.fromWeb(response.body as never);
      source.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
      });
      await pipeline(source, createWriteStream(destFile));
      return bytes;
    } catch (error) {
      if (isTimeoutError(error)) {
        throw this.timeoutError('скачивания', requestPath, timeoutMs, error);
      }
      throw safeError(error);
    }
  }

  private async request(
    path: string,
    job?: string,
    unavailableStatuses: readonly number[] = [],
    timeoutMs = this.config.settings.requestTimeoutMs,
    operation = 'запроса'
  ): Promise<Response | null> {
    if (job) {
      this.assertJobAllowed(job);
    }
    const url = `${this.config.baseUrl}/${path.replace(/^\/+/, '')}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: this.auth === undefined ? {} : { authorization: this.auth },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        throw this.timeoutError(operation, path, timeoutMs, error);
      }
      throw safeError(error);
    }
    if (unavailableStatuses.includes(response.status)) {
      return null;
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Jenkins вернул ${response.status}. Доступ к ресурсу не разрешён (режим ${this.config.auth ?? 'basic'}). ` +
          'Проверьте режим auth сервера, соответствующие учётные данные и права чтения ресурса.'
      );
    }
    if (response.status === 404) {
      throw new Error(`Адрес не найден: ${path}`);
    }
    if (!response.ok) {
      throw new Error(`Jenkins ответил ${response.status} на ${path}`);
    }
    return response;
  }

  get allowedJobs(): readonly string[] {
    return this.config.allowedJobs ?? [];
  }

  get settings(): Settings {
    return this.config.settings;
  }

  get workspaceNodeMax(): number {
    return this.config.workspaceNodeMax;
  }

  listJobs(parent = ''): Promise<JobItem[]> {
    return fetchJobList(this, parent);
  }

  listRuns(job: string, limit?: number): Promise<RunListItem[]> {
    return fetchRunList(this, job, limit);
  }

  listAllRuns(job: string): Promise<RunListItem[]> {
    return fetchAllRuns(this, job);
  }

  getBuildMeta(job: string, build: number): Promise<BuildMeta> {
    return fetchBuildMeta(this, job, build);
  }

  getLatestCompletedBuildMeta(job: string): Promise<BuildMeta | null> {
    return fetchLatestCompletedBuildMeta(this, job);
  }

  downloadConsoleLog(job: string, build: number, destFile: string): Promise<number> {
    return this.download(`${toJenkinsPath(job)}/${build}/consoleText`, destFile, job);
  }

  downloadArtifact(
    job: string,
    build: number,
    artifactPath: string,
    destFile: string
  ): Promise<number> {
    return this.download(
      `${toJenkinsPath(job)}/${build}/artifact/${artifactPath.split('/').map(encodeURIComponent).join('/')}`,
      destFile,
      job
    );
  }

  buildUrl(job: string, build: number): string | null {
    const baseUrl = this.config.baseUrl;
    return baseUrl ? `${baseUrl}/${toJenkinsPath(job)}/${build}` : null;
  }

  private assertJobAllowed(job: string): void {
    assertJobAllowed(this.config.allowedJobs, job);
  }

  private timeoutError(
    operation: string,
    path: string,
    timeoutMs: number,
    cause: unknown
  ): Error {
    const url = `${this.config.baseUrl}/${path.replace(/^\/+/, '')}`;
    return new Error(`Таймаут ${operation} ${maskUrlUserinfo(url)} через ${timeoutMs} мс`, { cause: safeError(cause) });
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}
