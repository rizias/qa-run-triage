import { readProfileFile } from './config.js';
import { fieldByName, resolveField } from './configFields.js';

export interface Settings {
  reportTimeZone: string;
  cacheKeepRuns: number;
  fingerprintLookbackDays: number;
  downloadTimeoutMs: number;
  requestTimeoutMs: number;
  runListDefault: number;
  runListMax: number;
  journalLockPollMs: number;
  journalLockTimeoutMs: number;
  reportWindowDays: number;
  archiveMaxBytes: number;
  journalInputMaxBytes: number;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  reportTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  cacheKeepRuns: 20,
  fingerprintLookbackDays: 30,
  downloadTimeoutMs: 120_000,
  requestTimeoutMs: 30_000,
  runListDefault: 20,
  runListMax: 50,
  journalLockPollMs: 20,
  journalLockTimeoutMs: 5_000,
  reportWindowDays: 14,
  archiveMaxBytes: 2_147_483_648,
  journalInputMaxBytes: 1_048_576
};

export const REPORT_FORMAT = {
  historyDays: 365,
  showLimits: {
    jobEntries: 500,
    openProblems: 50,
    signatureOccurrences: 200,
    windowEntries: 50
  },
  signatureIdLength: 16,
  signaturePreviewLength: 80,
  verdictPreviewLength: 120
} as const;

export function loadSettings(
  env: NodeJS.ProcessEnv = process.env,
  explicitConfigFile?: string,
  explicitProfile?: string,
  cwd?: string
): Settings {
  const { file } = readProfileFile(env, explicitConfigFile, explicitProfile, cwd);
  const settings = Object.fromEntries(
    (Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]).map((name) => {
      const spec = fieldByName(name === 'reportTimeZone' ? 'report.timeZone' : `limits.${name}`);
      return [name, resolveField(spec, env, file).value];
    })
  ) as unknown as Settings;
  if (settings.runListDefault > settings.runListMax) {
    throw new Error(
      'QA_RUN_TRIAGE_RUN_LIST_DEFAULT (поле runListDefault) не может быть больше ' +
        'QA_RUN_TRIAGE_RUN_LIST_MAX (поле runListMax)'
    );
  }
  return settings;
}
