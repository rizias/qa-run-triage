import { validateProfileName } from '../commonConfig.js';
import { DEFAULT_SETTINGS, type Settings } from '../settings.js';

export type Command =
  | { kind: 'runs'; job: string; limit: number }
  | { kind: 'record-runs'; job: string }
  | { kind: 'fetch'; job: string; build: number; force?: boolean }
  | { kind: 'source'; job: string; build: number; testClass: string }
  | { kind: 'summary'; job: string; build: number }
  | { kind: 'failures'; job: string; build: number; include: 'failed' | 'recovered' }
  | { kind: 'report'; outDir?: string; windowDays: number }
  | { kind: 'repair' }
  | { kind: 'config'; mode: 'show' | 'json' | 'init' | 'profiles' }
  | { kind: 'config-use'; profile: string }
  | { kind: 'journal-append' }
  | { kind: 'init' }
  | { kind: 'update' }
  | { kind: 'jobs'; parent: string }
  | { kind: 'query'; fingerprint: string; sinceDays: number };

export interface ParsedArgv {
  configFile?: string;
  profile?: string;
  rest: string[];
}

export function extractConfigFlag(argv: string[]): ParsedArgv {
  const rest: string[] = [];
  let configFile: string | undefined;
  let profile: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--config') {
      configFile = requireFlagValue('--config', argv[index + 1], '<путь>');
      index += 1;
      continue;
    }
    if (token === '--profile') {
      profile = requireFlagValue('--profile', argv[index + 1], '<имя>', true);
      index += 1;
      continue;
    }
    rest.push(token);
  }
  return { configFile, profile, rest };
}

type Handler = (argv: string[], settings: Settings) => Command;

const HANDLERS: Readonly<Record<string, Handler>> = {
  jobs: parseJobs,
  query: parseQuery,
  config: parseConfig,
  'journal-append': parseJournalAppend,
  report: parseReport,
  repair: parseRepair,
  runs: parseRuns,
  'record-runs': parseRecordRuns,
  fetch: parseFetch,
  summary: parseSummary,
  init: parseInit,
  update: parseUpdate,
  source: parseSource,
  failures: parseFailures
};

export function commandLoadsProfileSettings(rest: string[]): boolean {
  return !(rest[0] === 'config' && (rest[1] === 'init' || rest[1] === 'profiles' || rest[1] === 'use'));
}

function requireFlagValue(
  flag: string,
  value: string | undefined,
  placeholder: string,
  allowEmpty = false
): string {
  if (value === undefined || value.startsWith('-') || (!allowEmpty && value === '')) {
    throw new Error(`Флаг ${flag} требует значение: ${flag} ${placeholder}`);
  }
  return value;
}

function parseBuild(value: string | undefined, command: string): number {
  if (value === undefined || value === '') {
    throw new Error(`Укажите аргумент билд: ${command} <джоба> <билд>`);
  }
  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    throw new Error(
      `Аргумент билд должен быть положительным целым числом, получено "${value}". Используйте: ${command} <джоба> <билд>`
    );
  }
  return Number(value);
}

function parsePositiveInteger(value: string, argument: string): number {
  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    throw new Error(
      `Аргумент ${argument} должен быть положительным целым числом, получено "${value}".`
    );
  }
  return Number(value);
}

function requireJob(job: string | undefined, usage: string): string {
  if (!job || job.startsWith('--')) {
    throw new Error(`Укажите джобу. Используйте: ${usage}`);
  }
  return job;
}

function rejectUnknownTokens(argv: string[], used: number, usage: string): void {
  if (argv.length > used) {
    throw new Error(`Неизвестный аргумент "${argv[used]}". Используйте: ${usage}`);
  }
}

export function parseArgs(argv: string[], settings: Settings = DEFAULT_SETTINGS): Command {
  const [kind] = argv;
  if (!kind) {
    throw new Error(
      'Укажите команду: jobs, runs, record-runs, fetch, summary, failures, source, query, report, repair, ' +
        'config, journal-append, init или update'
    );
  }
  const handler = HANDLERS[kind];
  if (!handler) {
    throw new Error(`Неизвестная команда: ${kind}`);
  }
  return handler(argv, settings);
}

function parseQuery(argv: string[], settings: Settings): Command {
  const usage = 'query "текст" [дней]';
  const [, fingerprint, third] = argv;
  if (!fingerprint) {
    throw new Error('Укажите текст ошибки: query "текст" [дней]');
  }
  rejectUnknownTokens(argv, third === undefined ? 2 : 3, usage);
  return {
    kind: 'query',
    fingerprint,
    sinceDays: third ? parsePositiveInteger(third, 'дней') : settings.fingerprintLookbackDays
  };
}

function parseJobs(argv: string[]): Command {
  const usage = 'jobs [папка]';
  rejectUnknownTokens(argv, argv[1] === undefined ? 1 : 2, usage);
  return { kind: 'jobs', parent: argv[1] ?? '' };
}

function parseJournalAppend(argv: string[]): Command {
  rejectUnknownTokens(argv, 1, 'journal-append');
  return { kind: 'journal-append' };
}

function parseInit(argv: string[]): Command {
  rejectUnknownTokens(argv, 1, 'init');
  return { kind: 'init' };
}

function parseUpdate(argv: string[]): Command {
  rejectUnknownTokens(argv, 1, 'update');
  return { kind: 'update' };
}

function parseConfig(argv: string[]): Command {
  if (argv.length === 1) {
    return { kind: 'config', mode: 'show' };
  }
  if (argv.length === 2 && argv[1] === '--json') {
    return { kind: 'config', mode: 'json' };
  }
  if (argv.length === 2 && argv[1] === 'init') {
    return { kind: 'config', mode: 'init' };
  }
  if (argv.length === 2 && argv[1] === 'profiles') {
    return { kind: 'config', mode: 'profiles' };
  }
  if (argv.length === 3 && argv[1] === 'use' && argv[2]) {
    validateProfileName(argv[2]);
    return { kind: 'config-use', profile: argv[2] };
  }
  throw new Error(
    'Для config используйте: config, config --json, config init, config profiles или config use <имя>'
  );
}

function parseReport(argv: string[], settings: Settings): Command {
  let outDir: string | undefined;
  let windowDays = settings.reportWindowDays;
  for (let index = 1; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (option === '--out-dir') {
      outDir = requireFlagValue('--out-dir', value, '<каталог>');
    } else if (option === '--window-days') {
      windowDays = parsePositiveInteger(requireFlagValue('--window-days', value, '<дни>'), '--window-days');
    } else {
      throw new Error('Для report используйте: report [--out-dir <каталог>] [--window-days <дни>]');
    }
  }
  return { kind: 'report', ...(outDir ? { outDir } : {}), windowDays };
}

function parseRepair(argv: string[]): Command {
  if (argv.length !== 1) {
    throw new Error('Для repair не нужны аргументы');
  }
  return { kind: 'repair' };
}

function parseRuns(argv: string[], settings: Settings): Command {
  const usage = 'runs <джоба> [limit]';
  const job = requireJob(argv[1], usage);
  rejectUnknownTokens(argv, argv[2] === undefined ? 2 : 3, usage);
  const limit = argv[2] === undefined
    ? settings.runListDefault
    : parsePositiveInteger(argv[2], 'limit');
  if (limit > settings.runListMax) {
    throw new Error(
      `Аргумент limit не может быть больше ${settings.runListMax} ` +
        `(поле limits.runListMax), получено "${limit}".`
    );
  }
  return { kind: 'runs', job, limit };
}

function parseRecordRuns(argv: string[]): Command {
  const usage = 'record-runs <джоба>';
  const job = requireJob(argv[1], usage);
  rejectUnknownTokens(argv, 2, usage);
  return { kind: 'record-runs', job };
}

function parseFetch(argv: string[]): Command {
  const usage = 'fetch <джоба> <билд> [--force]';
  const job = requireJob(argv[1], usage);
  const force = argv[3] === '--force';
  rejectUnknownTokens(argv, force ? 4 : 3, usage);
  return { kind: 'fetch', job, build: parseBuild(argv[2], 'fetch'), ...(force ? { force: true } : {}) };
}

function parseSummary(argv: string[]): Command {
  const usage = 'summary <джоба> <билд>';
  const job = requireJob(argv[1], usage);
  rejectUnknownTokens(argv, 3, usage);
  return { kind: 'summary', job, build: parseBuild(argv[2], 'summary') };
}

function parseSource(argv: string[]): Command {
  const usage = 'source <джоба> <билд> <идентификатор>';
  const job = requireJob(argv[1], usage);
  if (!argv[3]?.trim() || argv[3].startsWith('--')) {
    throw new Error(`Не задан идентификатор. Используйте: ${usage}`);
  }
  rejectUnknownTokens(argv, 4, usage);
  return {
    kind: 'source',
    job,
    build: parseBuild(argv[2], 'source'),
    testClass: argv[3]
  };
}

function parseFailures(argv: string[]): Command {
  const usage = 'failures <джоба> <билд> [--recovered]';
  const job = requireJob(argv[1], usage);
  let buildToken: string | undefined;
  let include: 'failed' | 'recovered' = 'failed';
  for (const token of argv.slice(2)) {
    if (token === '--recovered') {
      include = 'recovered';
      continue;
    }
    if (token.startsWith('--') || buildToken !== undefined) {
      throw new Error(`Неизвестный аргумент "${token}". Используйте: ${usage}`);
    }
    buildToken = token;
  }
  return { kind: 'failures', job, build: parseBuild(buildToken, 'failures'), include };
}
