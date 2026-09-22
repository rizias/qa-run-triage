import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  sourceArchiveFile,
  sourceExtractedDir,
  sourceHashDir,
  sourcesByHashDir
} from '../fetcher/cachePaths.js';
import { extractZip } from '../fetcher/extractZip.js';
import { renameWithRetry } from '../lock.js';

const SOURCE_ARCHIVE = 'src.zip';
const SOURCE_CACHE_META = 'cache.json';

export interface SourceCacheMeta {
  sha256: string;
  archiveBytes: number;
  extractedBytes: number;
  skipped: string[];
}

export async function cacheSources(
  cacheDir: string,
  knownSha256: string | null,
  download: (destFile: string) => Promise<number>,
  archiveMaxBytes: number
): Promise<SourceCacheMeta> {
  if (knownSha256 && sourceCacheReady(cacheDir, knownSha256)) {
    return readSourceCacheMeta(cacheDir, knownSha256);
  }

  const cacheRoot = sourcesByHashDir(cacheDir);
  mkdirSync(cacheRoot, { recursive: true });
  const tempDir = path.join(cacheRoot, `.tmp-${process.pid}-${Date.now()}`);
  const archiveFile = path.join(tempDir, SOURCE_ARCHIVE);
  const extractedDir = path.join(tempDir, 'extracted');
  mkdirSync(extractedDir, { recursive: true });

  try {
    const archiveBytes = await download(archiveFile);
    const sha256 = await fileSha256(archiveFile);
    if (sourceCacheReady(cacheDir, sha256)) {
      return readSourceCacheMeta(cacheDir, sha256);
    }

    const extracted = await extractZip(
      archiveFile,
      extractedDir,
      (entryName) => entryName.startsWith('src/') ? entryName : null,
      { maxUncompressedBytes: archiveMaxBytes, archiveName: SOURCE_ARCHIVE }
    );
    const cacheMeta: SourceCacheMeta = {
      sha256,
      archiveBytes,
      extractedBytes: extracted.bytesWritten,
      skipped: extracted.skipped
    };
    writeFileSync(
      path.join(tempDir, SOURCE_CACHE_META),
      JSON.stringify(cacheMeta, null, 2),
      'utf8'
    );

    const finalDir = sourceHashDir(cacheDir, sha256);
    try {
      renameWithRetry(tempDir, finalDir);
    } catch (error) {
      if (sourceCacheReady(cacheDir, sha256)) {
        return readSourceCacheMeta(cacheDir, sha256);
      }
      throw error;
    }
    return cacheMeta;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function sourceCacheReady(cacheDir: string, sha256: string): boolean {
  return existsSync(sourceArchiveFile(cacheDir, sha256)) &&
    existsSync(sourceExtractedDir(cacheDir, sha256));
}

function readSourceCacheMeta(cacheDir: string, sha256: string): SourceCacheMeta {
  const metaFile = path.join(sourceHashDir(cacheDir, sha256), SOURCE_CACHE_META);
  if (existsSync(metaFile)) {
    try {
      return JSON.parse(readFileSync(metaFile, 'utf8')) as SourceCacheMeta;
    } catch (error) {
      throw new Error(
        `Файл ${metaFile} не разбирается как JSON: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }
  return {
    sha256: sha256.toLowerCase(),
    archiveBytes: statSync(sourceArchiveFile(cacheDir, sha256)).size,
    extractedBytes: directoryBytes(sourceExtractedDir(cacheDir, sha256)),
    skipped: []
  };
}

function directoryBytes(root: string): number {
  let bytes = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      bytes += directoryBytes(file);
    } else if (entry.isFile()) {
      bytes += statSync(file).size;
    }
  }
  return bytes;
}

async function fileSha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}
