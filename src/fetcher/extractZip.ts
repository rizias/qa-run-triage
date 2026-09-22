import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

export interface ExtractLimits {
  maxUncompressedBytes: number;
  archiveName: string;
}

export interface ExtractResult {
  bytesWritten: number;
  skipped: string[];
}

const FIELD = 'limits.archiveMaxBytes';

export class ArchiveLimitError extends Error {}
const SYMLINK_MODE = 0o120000;
const FILE_TYPE_MASK = 0o170000;

export async function extractZip(
  zipFile: string,
  destDir: string,
  selectEntry: (entryName: string) => string | null,
  limits: ExtractLimits
): Promise<ExtractResult> {
  const root = path.resolve(destDir);
  const zip = await yauzl.openPromise(zipFile, {
    lazyEntries: true,
    autoClose: false,
    validateEntrySizes: false,
    decodeStrings: false
  });
  let bytesWritten = 0;
  const skipped: string[] = [];

  try {
    for await (const entry of zip.eachEntry()) {
      const rawName = (entry.fileName as unknown as Buffer).toString('utf8');
      if (isDirectoryEntry(rawName)) {
        continue;
      }
      const entryName = rawName.replaceAll('\\', '/');
      if (isZipSymlink(entry)) {
        skipped.push(rawName);
        continue;
      }
      const relativePath = selectEntry(entryName);
      if (!relativePath) {
        continue;
      }
      const target = path.resolve(root, relativePath);
      if (target !== root && !target.startsWith(root + path.sep)) {
        skipped.push(rawName);
        continue;
      }
      bytesWritten = await writeEntry(zip, entry, target, limits, bytesWritten);
    }
  } finally {
    zip.close();
  }

  return { bytesWritten, skipped };
}

function isDirectoryEntry(name: string): boolean {
  return name.endsWith('/');
}

async function writeEntry(
  zip: ZipFile,
  entry: Entry,
  target: string,
  limits: ExtractLimits,
  bytesWritten: number
): Promise<number> {
  mkdirSync(path.dirname(target), { recursive: true });
  const readStream = await zip.openReadStreamPromise(entry);
  const writeStream = createWriteStream(target);
  let entryBytes = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      readStream.on('data', (chunk: Buffer) => {
        entryBytes += chunk.length;
        if (bytesWritten + entryBytes > limits.maxUncompressedBytes) {
          readStream.destroy();
          writeStream.destroy();
          reject(limitExceededError(limits, bytesWritten + entryBytes));
        }
      });
      readStream.on('error', reject);
      writeStream.on('error', reject);
      writeStream.on('finish', resolve);
      readStream.pipe(writeStream);
    });
  } catch (error) {
    rmSync(target, { force: true });
    throw error;
  }

  return bytesWritten + entryBytes;
}

function limitExceededError(limits: ExtractLimits, total: number): Error {
  return new ArchiveLimitError(
    `Архив ${limits.archiveName} превышает ${FIELD} (${limits.maxUncompressedBytes}): несжатый размер не меньше ${total} байт.`
  );
}

function isZipSymlink(entry: Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & FILE_TYPE_MASK;
  return mode === SYMLINK_MODE;
}

const WANTED = ['data/test-cases/', 'data/attachments/', 'widgets/', 'history/'];
const ARCHIVE_ROOT = 'allure-report/';

export async function extractReport(
  zipFile: string,
  destDir: string,
  archiveName: string,
  archiveMaxBytes: number
): Promise<ExtractResult> {
  return extractZip(zipFile, destDir, (entryName) => {
    const inner = entryName.startsWith(ARCHIVE_ROOT)
      ? entryName.slice(ARCHIVE_ROOT.length)
      : entryName;
    return WANTED.some((prefix) => inner.startsWith(prefix))
      ? path.posix.join('allure-report', inner)
      : null;
  }, { maxUncompressedBytes: archiveMaxBytes, archiveName });
}
