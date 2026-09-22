import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { atomicWriteFile } from '../lock.js';
import { DEFAULT_SETTINGS, type Settings } from '../settings.js';
import { entryHtml } from './clientAssets.js';
import { buildData } from './reportData.js';
import { availableFile, availableLabel, timestampLabel, writeGeneration } from './writeGeneration.js';
import type { ResolveRunServer } from '../journal/identity.js';

export interface JournalReportOptions {
  resolveServer?: ResolveRunServer;
  outDir?: string;
  windowDays?: number;
  generatedAt?: Date;
  settings?: Settings;
}

export function writeJournalReport(cacheDir: string, options: JournalReportOptions = {}): string {
  const generatedAt = options.generatedAt ?? new Date();
  const windowDays = options.windowDays
    ?? options.settings?.reportWindowDays
    ?? DEFAULT_SETTINGS.reportWindowDays;
  if (!Number.isInteger(windowDays) || windowDays <= 0) {
    throw new Error('window-days должен быть положительным целым числом');
  }
  if (Number.isNaN(generatedAt.getTime())) {
    throw new Error('generatedAt должен быть корректной датой');
  }

  const outputDir = options.outDir ?? path.join(cacheDir, 'journal-report');
  const generationsDir = path.join(outputDir, 'gens');
  mkdirSync(generationsDir, { recursive: true });

  const generation = availableLabel(generationsDir, timestampLabel(generatedAt));
  const generationDir = path.join(generationsDir, generation);
  mkdirSync(generationDir);

  const timeZone = options.settings?.reportTimeZone ?? DEFAULT_SETTINGS.reportTimeZone;
  const data = buildData(cacheDir, generatedAt, windowDays, options.resolveServer, timeZone);
  writeGeneration(generationDir, data);

  const currentFile = path.join(outputDir, 'current.js');
  if (existsSync(currentFile)) {
    const previous = readFileSync(currentFile, 'utf8');
    const backup = availableFile(outputDir, `current.js.prev-${generation}`);
    writeFileSync(backup, previous, 'utf8');
  }

  atomicWriteFile(
    currentFile,
    `window.QA_REPORT_CURRENT = ${JSON.stringify(`gens/${generation}/index.html`)};\n`
  );
  atomicWriteFile(path.join(outputDir, 'index.html'), entryHtml());
  return outputDir;
}
