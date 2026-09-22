import type { BuildMeta, CiClient, SourceFreshness } from '../ci/client.js';
import { cacheSources } from './sourceCache.js';
import { ArchiveLimitError } from '../fetcher/extractZip.js';

const SOURCE_ARCHIVE = 'src.zip';

export async function fetchWorkspaceSource(
  client: CiClient,
  cacheDir: string,
  job: string,
  build: number,
  meta: BuildMeta,
  preferredNode: number | undefined,
  missing: { name: string; reason: string }[],
  files: { name: string; bytes: number }[],
  saveNode: (node: number | null) => void,
  saveSource: (source: { sha256: string }) => void,
  archiveMaxBytes: number
): Promise<SourceFreshness> {
  try {
    const latest = await client.getLatestCompletedBuildMeta(job);
    const freshness = makeSourceFreshness(meta.commit, latest?.commit ?? null);
    const node = await client.findWorkspaceNode(job, build, preferredNode);
    saveNode(node);
    if (node === null) {
      missing.push({
        name: SOURCE_ARCHIVE,
        reason: `Рабочий каталог прогона недоступен: узел не найден при проверке номеров от 1 до ${client.workspaceNodeMax}`
      });
      return freshness;
    }

    const cachedSource = await cacheSources(
      cacheDir,
      null,
      async (destFile) => {
        const bytes = await client.downloadWorkspaceSource(job, build, node, destFile);
        if (bytes === null) {
          throw new Error('сервер вернул 403 или 404 при скачивании исходников');
        }
        return bytes;
      },
      archiveMaxBytes
    );
    const prefix = `sources-by-hash/${cachedSource.sha256}`;
    saveSource({ sha256: cachedSource.sha256 });
    files.push({ name: `${prefix}/${SOURCE_ARCHIVE}`, bytes: cachedSource.archiveBytes });
    files.push({ name: `${prefix}/extracted/`, bytes: cachedSource.extractedBytes });
    addSkippedEntries(missing, cachedSource.skipped);
    return freshness;
  } catch (error) {
    if (error instanceof ArchiveLimitError) throw error;
    missing.push({
      name: SOURCE_ARCHIVE,
      reason: `Рабочий каталог прогона недоступен: ${workspaceErrorReason(error)}`
    });
    return {
      isCurrent: null,
      runCommit: meta.commit,
      latestBuildCommit: null,
      warning: null
    };
  }
}

function makeSourceFreshness(
  runCommit: string | null,
  latestBuildCommit: string | null
): SourceFreshness {
  if (runCommit === null || latestBuildCommit === null) {
    return { isCurrent: null, runCommit, latestBuildCommit, warning: null };
  }
  if (runCommit === latestBuildCommit) {
    return { isCurrent: true, runCommit, latestBuildCommit, warning: null };
  }
  return {
    isCurrent: false,
    runCommit,
    latestBuildCommit,
    warning: `Показан код более нового прогона, коммита ${latestBuildCommit}, вместо кода разбираемого прогона ${runCommit}.`
  };
}

function workspaceErrorReason(error: unknown): string {
  if (error instanceof Error && (error.message.includes('403') || error.message.includes('404'))) {
    return error.message;
  }
  if (error instanceof Error) {
    return `сетевая ошибка: ${error.message}`;
  }
  return 'сетевая ошибка';
}

function addSkippedEntries(
  missing: { name: string; reason: string }[],
  entries: string[]
): void {
  for (const entryName of entries) {
    missing.push({
      name: entryName,
      reason: `Запись архива исходников указывает за пределы каталога, пропущена (zip slip)`
    });
  }
}
