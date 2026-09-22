import type { Config } from '../config.js';
import { buildRunUrl } from '../ci/createClient.js';

export function createBuildUrl(
  config: Config,
  serverName: string | undefined,
  job: string,
  build: number
): string | null {
  const server = serverName ? config.servers[serverName] : undefined;
  if (!server?.baseUrl) {
    return null;
  }
  return buildRunUrl(server.kind, server.baseUrl, job, build);
}
