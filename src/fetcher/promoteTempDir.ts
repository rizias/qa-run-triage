import { existsSync, rmSync } from 'node:fs';
import { renameWithRetry } from '../lock.js';
import path from 'node:path';

export function promoteTempDir(tempDir: string, finalDir: string): void {
  const backupDir = existsSync(finalDir)
    ? `${finalDir}.backup-${process.pid}-${Date.now()}`
    : undefined;
  if (backupDir) {
    renameWithRetry(finalDir, backupDir);
  }
  try {
    renameWithRetry(tempDir, finalDir);
  } catch (error) {
    if (backupDir && existsSync(backupDir) && !existsSync(finalDir)) {
      renameWithRetry(backupDir, finalDir);
    }
    throw error;
  }
  if (backupDir) {
    preserveLegacySources(backupDir, finalDir);
    rmSync(backupDir, { recursive: true, force: true });
  }
}

function preserveLegacySources(backupDir: string, finalDir: string): void {
  const legacyDir = path.join(backupDir, 'sources');
  const preservedDir = path.join(finalDir, 'sources');
  if (existsSync(legacyDir) && !existsSync(preservedDir)) {
    renameWithRetry(legacyDir, preservedDir);
  }
}
