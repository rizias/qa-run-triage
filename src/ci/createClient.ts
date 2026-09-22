import type { Config } from '../config.js';
import { SERVER_KINDS } from '../configFields.js';
import { JenkinsClient } from '../jenkins/client.js';
import { toJenkinsPath } from '../jenkins/paths.js';
import { requireServer } from '../serverResolution.js';
import type { CiClient } from './client.js';

export const LEGACY_BUILD_URL_FIELD = 'jenkinsUrl';

export function createCiClient(config: Config, serverName: string): CiClient {
  const required = requireServer(
    config.servers,
    serverName,
    config.profileFile,
    config.credentialsFile
  );
  const server = config.servers[serverName];
  if (server.kind === 'jenkins') {
    return new JenkinsClient({
      ...required,
      allowedJobs: config.allowedJobs,
      settings: config.settings,
      workspaceNodeMax: server.workspaceNodeMax
    });
  }
  throw unknownKindError(`servers.${serverName}.kind`, server.kind);
}

export function buildRunUrl(
  kind: string,
  baseUrl: string,
  job: string,
  build: number
): string | null {
  if (!baseUrl) {
    return null;
  }
  if (kind === 'jenkins') {
    return `${baseUrl}/${toJenkinsPath(job)}/${build}`;
  }
  throw unknownKindError('kind', kind);
}

function unknownKindError(field: string, kind: string): Error {
  return new Error(
    `Поле ${field} имеет неподдерживаемое значение "${kind}". ` +
      `Поддерживаемые значения: ${SERVER_KINDS.join(', ')}.`
  );
}
