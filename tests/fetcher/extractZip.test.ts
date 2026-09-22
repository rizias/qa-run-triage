import { describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdtempSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { extractZip } from '../../src/fetcher/extractZip.js';

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'qa-run-triage-zip-'));
}

function writeZip(file: string, entries: { name: string; content: Buffer; attr?: number }[]): void {
  const zip = new AdmZip();
  for (const entry of entries) {
    const added = zip.addFile(entry.name, entry.content);
    if (entry.attr !== undefined) {
      added.attr = entry.attr;
    }
  }
  zip.writeZip(file);
}

function writeUint32LE(buffer: Buffer, offset: number, value: number): void {
  buffer.writeUInt32LE(value >>> 0, offset);
}

function writeLyingZip(file: string, entryName: string, inflated: Buffer): void {
  const compressed = deflateRawSync(inflated);
  const nameBytes = Buffer.from(entryName, 'utf8');
  const declaredUncompressedSize = 1;
  const crc = 0;

  const localHeader = Buffer.alloc(30);
  writeUint32LE(localHeader, 0, 0x04034b50);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  writeUint32LE(localHeader, 14, crc);
  writeUint32LE(localHeader, 18, compressed.length);
  writeUint32LE(localHeader, 22, declaredUncompressedSize);
  localHeader.writeUInt16LE(nameBytes.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const centralOffset = localHeader.length + nameBytes.length + compressed.length;
  const centralHeader = Buffer.alloc(46);
  writeUint32LE(centralHeader, 0, 0x02014b50);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(0, 14);
  writeUint32LE(centralHeader, 16, crc);
  writeUint32LE(centralHeader, 20, compressed.length);
  writeUint32LE(centralHeader, 24, declaredUncompressedSize);
  centralHeader.writeUInt16LE(nameBytes.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  writeUint32LE(centralHeader, 36, 0);
  writeUint32LE(centralHeader, 38, 0);
  writeUint32LE(centralHeader, 42, 0);

  const endRecord = Buffer.alloc(22);
  writeUint32LE(endRecord, 0, 0x06054b50);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(1, 8);
  endRecord.writeUInt16LE(1, 10);
  writeUint32LE(endRecord, 12, centralHeader.length + nameBytes.length);
  writeUint32LE(endRecord, 16, centralOffset);
  endRecord.writeUInt16LE(0, 20);

  writeFileSync(file, Buffer.concat([
    localHeader,
    nameBytes,
    compressed,
    centralHeader,
    nameBytes,
    endRecord
  ]));
}

describe('Распаковка архива', () => {
  it('Архив больше предела не распаковывается', async () => {
    const dir = tempDir();
    const zipFile = path.join(dir, 'src.zip');
    const dest = path.join(dir, 'out');
    writeZip(zipFile, [{ name: 'src/a.txt', content: Buffer.alloc(200, 97) }]);
    await expect(
      extractZip(zipFile, dest, (name) => name, {
        maxUncompressedBytes: 50,
        archiveName: 'src.zip'
      })
    ).rejects.toThrow(/src\.zip[\s\S]*limits\.archiveMaxBytes[\s\S]*50/);
    expect(existsSync(path.join(dest, 'src', 'a.txt'))).toBe(false);
  });

  it('Симлинк в архиве не создаёт ссылку на диске', async () => {
    const dir = tempDir();
    const zipFile = path.join(dir, 'src.zip');
    const dest = path.join(dir, 'out');
    writeZip(zipFile, [
      { name: 'src/ok.txt', content: Buffer.from('ok'), attr: (0o100644 << 16) >>> 0 },
      { name: 'src/link', content: Buffer.from('/tmp/x'), attr: (0o120777 << 16) >>> 0 }
    ]);
    const result = await extractZip(zipFile, dest, (name) => name, {
      maxUncompressedBytes: 10_000,
      archiveName: 'src.zip'
    });
    expect(existsSync(path.join(dest, 'src', 'ok.txt'))).toBe(true);
    expect(result.skipped).toContain('src/link');
    const link = path.join(dest, 'src', 'link');
    expect(existsSync(link) && lstatSync(link).isSymbolicLink()).toBe(false);
  });

  it('заявленный размер записи не спасает от предела, когда фактические данные больше', async () => {
    const dir = tempDir();
    const zipFile = path.join(dir, 'lying.zip');
    const dest = path.join(dir, 'out');
    writeLyingZip(zipFile, 'src/big.txt', Buffer.alloc(5_000, 97));

    await expect(
      extractZip(zipFile, dest, (name) => name, {
        maxUncompressedBytes: 100,
        archiveName: 'lying.zip'
      })
    ).rejects.toThrow(/lying\.zip[\s\S]*limits\.archiveMaxBytes[\s\S]*100/);
    expect(existsSync(path.join(dest, 'src', 'big.txt'))).toBe(false);
  });
});
