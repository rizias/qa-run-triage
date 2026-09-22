import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeJournalReport } from '../../src/htmlreport/report.js';
import { entry, generatedAt, generationDir, makeCache, readData } from './fixtures.js';

type SeriesIndex = Array<{ id: string; pairs: Array<{ job: string; env: string }> }>;
type Series = { text: string; occurrences: Array<{ job: string; build: number }> };

describe('подпись в разных джобах', () => {
  it('один текст ошибки в двух джобах — своя запись у каждой пары джоба-окружение', () => {
    const sharedText = 'Общая ошибка между джобами';
    const cacheDir = makeCache([
      entry({ job: 'backend/smoke', build: 1, env: 'stage', fingerprints: [sharedText] }),
      entry({ job: 'backend/other', build: 1, env: 'stage', fingerprints: [sharedText] })
    ]);
    const outputDir = mkdtempSync(path.join(os.tmpdir(), 'qa-report-out-'));
    writeJournalReport(cacheDir, { outDir: outputDir, generatedAt });
    const generation = generationDir(outputDir);
    const id = createHash('sha256').update(sharedText).digest('hex').slice(0, 16);

    const index = readData<SeriesIndex>(path.join(generation, 'data', 'signatures', 'index.js'));
    const series = readData<Series>(path.join(generation, 'data', 'signatures', `${id}.js`));

    const record = index.find((item) => item.id === id)!;
    expect(record.pairs).toEqual(expect.arrayContaining([
      expect.objectContaining({ job: 'backend/smoke', env: 'stage' }),
      expect.objectContaining({ job: 'backend/other', env: 'stage' })
    ]));
    expect(record.pairs).toHaveLength(2);
    expect(series.occurrences.map((item) => item.job)).toEqual(
      expect.arrayContaining(['backend/smoke', 'backend/other'])
    );
  });
});
