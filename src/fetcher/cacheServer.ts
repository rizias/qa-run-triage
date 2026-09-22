import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import { parseJsonText } from '../jsonFile.js';
import { resolveServerNameForJobLenient } from '../serverResolution.js';
import { runDir } from './cachePaths.js';

export function connectionIdentity(server: string, baseUrl: string): string {
  const url = new URL(baseUrl);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return JSON.stringify([server, url.href.replace(/\/+$/, '')]);
}

export function cachedRunMatches(
  cacheDir: string, job: string, build: number, server?: string, baseUrl?: string
): boolean {
  const file = path.join(runDir(cacheDir, job, build), 'manifest.json');
  if (!existsSync(file)) return true;
  const manifest = parseJsonText(file, readFileSync(file, 'utf8')) as { server?: string; serverIdentity?: string };
  if (manifest.server !== undefined && manifest.server !== server) return false;
  if (manifest.serverIdentity === undefined) return true;
  if (!server || !baseUrl) return false;
  return manifest.serverIdentity === connectionIdentity(server, baseUrl);
}

export function assertCachedServer(config: Config, job: string, build: number): void {
  const current = resolveServerNameForJobLenient(
    config.jobs, config.defaultServer, Object.keys(config.servers), job
  );
  if (!cachedRunMatches(config.cacheDir, job, build, current, current ? config.servers[current]?.baseUrl : undefined)) {
    throw new Error(`Прогон ${job} #${build} не скачан с текущего сервера. Выполните команду fetch.`);
  }
}
