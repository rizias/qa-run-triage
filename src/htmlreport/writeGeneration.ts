import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { REPORT_FORMAT } from '../settings.js';
import { reportUtcOffset } from '../reportTimeZone.js';
import { pageHtml, STYLE_CSS, APP_JS } from './clientAssets.js';
import { compareReportRecent, toOccurrence, type ReportData } from './reportData.js';

export function writeGeneration(root: string, data: ReportData): void {
  const months = [...data.months.keys()].sort().reverse();
  writeFile(root, 'style.css', STYLE_CSS);
  writeFile(root, 'app.js', APP_JS);
  writeData(root, 'data/meta.js', 'QA_REPORT_META', {
    generatedAt: data.generatedAt.toISOString(),
    generatedAtTimestamp: data.generatedAt.getTime(),
    windowDays: data.windowDays,
    windowStart: data.windowStart,
    yearStart: data.yearStart,
    timeZone: data.timeZone,
    utcOffset: reportUtcOffset(data.timeZone, data.generatedAt),
    skippedLines: data.skippedLines,
    incompleteEntries: data.incompleteEntries,
    months,
    limits: REPORT_FORMAT.showLimits
  });

  const jobs = [...new Set(data.reportEntries.map((entry) => entry.jobKey))]
    .sort((left, right) => left.localeCompare(right));
  const signatureById = new Map(data.signatures.map((series) => [series.id, series]));
  const jobSummaries = jobs.map((key) => {
    const runs = data.reportEntries.filter((entry) => entry.jobKey === key).sort(compareReportRecent);
    const { job, server } = runs[0];
    const openIds = new Set<string>();
    for (const series of data.signatures) {
      if (series.pairs.some((pair) => pair.job === job && pair.server === server && pair.status === 'open')) {
        openIds.add(series.id);
      }
    }
    return {
      job,
      server,
      key,
      latest: runs[0] ?? null,
      openProblems: openIds.size,
      openSignatures: [...openIds].map((id) => {
        const series = signatureById.get(id)!;
        return { id, preview: series.preview, legacy: series.legacy };
      })
    };
  });
  writeData(root, 'data/jobs.js', 'QA_REPORT_JOBS', jobSummaries);

  for (const key of jobs) {
    const runs = data.reportEntries.filter((entry) => entry.jobKey === key).sort(compareReportRecent);
    writeData(root, `data/jobs/${key}.js`, 'QA_REPORT_JOB', {
      job: runs[0].job,
      server: runs[0].server,
      key,
      runs
    });
  }
  for (const [month, entries] of data.months) {
    writeData(root, `data/months/${month}.js`, 'QA_REPORT_MONTH', {
      month,
      entries: [...entries].sort(compareReportRecent)
    });
  }

  writeData(root, 'data/signatures/index.js', 'QA_REPORT_SIGNATURES', data.signatures.map((series) => ({
    id: series.id,
    preview: series.preview,
    count: series.occurrences.length,
    first: series.first,
    last: series.last,
    status: series.status,
    legacy: series.legacy,
    jobs: [...new Set(series.occurrences.map(({ entry }) =>
      entry.server ? `${entry.server} / ${entry.job}` : entry.job))].sort(),
    pairs: series.pairs
  })));
  for (const series of data.signatures) {
    writeData(root, `data/signatures/${series.id}.js`, 'QA_REPORT_SIGNATURE', {
      id: series.id,
      text: series.text,
      preview: series.preview,
      count: series.occurrences.length,
      first: series.first,
      last: series.last,
      status: series.status,
      legacy: series.legacy,
      pairs: series.pairs,
      occurrences: series.occurrences.map((view) => toOccurrence(view))
    });
  }
  const recentMonths = months.filter((month) => {
    const entries = data.months.get(month) ?? [];
    return entries.some((entry) => entry.time >= data.windowStart && entry.time <= data.generatedAt.getTime());
  });
  writeFile(root, 'index.html', pageHtml('dashboard', '', [
    'data/meta.js',
    'data/jobs.js',
    'data/signatures/index.js',
    ...recentMonths.map((month) => `data/months/${month}.js`),
    'app.js'
  ], true));

  for (const job of jobSummaries) {
    writeFile(root, `jobs/${job.key}.html`, pageHtml('job', '../', [
      '../data/meta.js',
      `../data/jobs/${job.key}.js`,
      '../data/signatures/index.js',
      '../app.js'
    ]));
  }
  writeFile(root, 'signatures/index.html', pageHtml('signatures', '../', [
    '../data/meta.js',
    '../data/signatures/index.js',
    '../app.js'
  ]));
  for (const series of data.signatures) {
    writeFile(root, `signatures/${series.id}.html`, pageHtml('signature', '../', [
      '../data/meta.js',
      `../data/signatures/${series.id}.js`,
      '../app.js'
    ]));
  }
  writeFile(root, 'archive/index.html', pageHtml('archive', '../', [
    '../data/meta.js',
    '../app.js'
  ]));
  for (const month of months) {
    writeFile(root, `archive/${month}.html`, pageHtml('month', '../', [
      '../data/meta.js',
      `../data/months/${month}.js`,
      '../app.js'
    ]));
  }
}

export function timestampLabel(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, '');
}

export function availableLabel(root: string, preferred: string): string {
  let candidate = preferred;
  let suffix = 1;
  while (existsSync(path.join(root, candidate))) {
    candidate = `${preferred}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function availableFile(root: string, preferred: string): string {
  let candidate = path.join(root, preferred);
  let suffix = 1;
  while (existsSync(candidate)) {
    candidate = path.join(root, `${preferred}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

function writeFile(root: string, relative: string, content: string): void {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

function writeData(root: string, relative: string, variable: string, value: unknown): void {
  writeFile(root, relative, `window.${variable} = ${JSON.stringify(value)};\n`);
}
