import os from 'node:os';
import path from 'node:path';
import { AUTH_MODES, CREDENTIAL_FIELDS, type AuthMode } from './serverAuth.js';
import { assertReportTimeZone } from './reportTimeZone.js';

export type FieldType = 'string' | 'number' | 'stringArray';
export type FieldSource = 'env' | 'file' | 'default';

export interface EnvironmentConfig {
  readonly env: readonly string[];
  readonly city: readonly string[];
}

export interface FieldSpec {
  readonly name: string;
  readonly envName?: string;
  readonly type: FieldType;
  readonly default?: string | number | readonly string[];
  readonly required?: boolean;
  readonly secret?: boolean;
  readonly enum?: readonly string[];
}

export type FieldValue = string | number | readonly string[] | undefined;

export interface FieldResolution {
  readonly value: FieldValue;
  readonly source: FieldSource;
}

export interface JobGroupSpec {
  server?: string;
}

export interface LimitsSection {
  cacheKeepRuns?: number;
  reportWindowDays?: number;
  fingerprintLookbackDays?: number;
  requestTimeoutMs?: number;
  downloadTimeoutMs?: number;
  runListDefault?: number;
  runListMax?: number;
  journalLockTimeoutMs?: number;
  journalLockPollMs?: number;
  archiveMaxBytes?: number;
  journalInputMaxBytes?: number;
}

export interface ServerSpec {
  kind?: string;
  auth?: AuthMode;
  baseUrl?: string;
  reportArtifact?: string;
  workspaceNodeMax?: number;
}

export interface CredentialsEntry {
  proxyUser?: string;
  proxyPass?: string;
  user?: string;
  token?: string;
}

export type CredentialsFile = Record<string, CredentialsEntry>;

export interface ProfileFile {
  description?: string;
  servers?: Record<string, ServerSpec>;
  jobs?: Record<string, JobGroupSpec>;
  defaultServer?: string;
  repos?: string[];
  environment?: EnvironmentConfig;
  allowedJobs?: string[];
  limits?: LimitsSection;
  report?: { timeZone?: string };
}

export interface CommonFile {
  profile?: string;
  bindings?: Record<string, string>;
}

export const SERVER_KINDS = ['jenkins'] as const;
export const DEFAULT_REPORT_ARTIFACT = 'allure-report.zip';
export const DEFAULT_WORKSPACE_NODE_MAX = 40;
export const DEFAULT_ENVIRONMENT: EnvironmentConfig = { env: ['env'], city: ['city'] };
export const CACHE_DIR_ENV_NAME = 'QA_RUN_TRIAGE_CACHE_DIR';
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
export const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const DEFAULT_SERVER_NAME = 'main';

export const CONFIG_FIELDS: readonly FieldSpec[] = [
  { name: 'description', type: 'string', default: '' },
  { name: 'allowedJobs', type: 'stringArray', default: [] },
  { name: 'report.timeZone', envName: 'QA_RUN_TRIAGE_REPORT_TIME_ZONE', type: 'string', default: Intl.DateTimeFormat().resolvedOptions().timeZone },
  { name: 'limits.cacheKeepRuns', envName: 'QA_RUN_TRIAGE_CACHE_KEEP_RUNS', type: 'number', default: 20 },
  {
    name: 'limits.reportWindowDays',
    envName: 'QA_RUN_TRIAGE_REPORT_WINDOW_DAYS',
    type: 'number',
    default: 14
  },
  {
    name: 'limits.fingerprintLookbackDays',
    envName: 'QA_RUN_TRIAGE_FINGERPRINT_LOOKBACK_DAYS',
    type: 'number',
    default: 30
  },
  {
    name: 'limits.requestTimeoutMs',
    envName: 'QA_RUN_TRIAGE_REQUEST_TIMEOUT_MS',
    type: 'number',
    default: 30_000
  },
  {
    name: 'limits.downloadTimeoutMs',
    envName: 'QA_RUN_TRIAGE_DOWNLOAD_TIMEOUT_MS',
    type: 'number',
    default: 120_000
  },
  {
    name: 'limits.runListDefault',
    envName: 'QA_RUN_TRIAGE_RUN_LIST_DEFAULT',
    type: 'number',
    default: 20
  },
  {
    name: 'limits.runListMax',
    envName: 'QA_RUN_TRIAGE_RUN_LIST_MAX',
    type: 'number',
    default: 50
  },
  {
    name: 'limits.journalLockTimeoutMs',
    envName: 'QA_RUN_TRIAGE_JOURNAL_LOCK_TIMEOUT_MS',
    type: 'number',
    default: 5_000
  },
  {
    name: 'limits.journalLockPollMs',
    envName: 'QA_RUN_TRIAGE_JOURNAL_LOCK_POLL_MS',
    type: 'number',
    default: 20
  },
  {
    name: 'limits.archiveMaxBytes',
    envName: 'QA_RUN_TRIAGE_ARCHIVE_MAX_BYTES',
    type: 'number',
    default: 2_147_483_648
  },
  {
    name: 'limits.journalInputMaxBytes',
    envName: 'QA_RUN_TRIAGE_JOURNAL_INPUT_MAX_BYTES',
    type: 'number',
    default: 1_048_576
  }
];

export type ServerFieldName = 'kind' | 'auth' | 'baseUrl' | 'reportArtifact' | keyof CredentialsEntry;

export interface ServerFieldSpec {
  readonly field: ServerFieldName;
  readonly envSuffix: string;
  readonly file: 'servers' | 'credentials';
  readonly default?: string;
  readonly required?: boolean;
  readonly secret?: boolean;
  readonly enum?: readonly string[];
}

export const SERVER_FIELDS: readonly ServerFieldSpec[] = [
  { field: 'kind', envSuffix: 'KIND', file: 'servers', default: SERVER_KINDS[0], enum: SERVER_KINDS },
  { field: 'auth', envSuffix: 'AUTH', file: 'servers', default: 'basic', enum: AUTH_MODES },
  { field: 'baseUrl', envSuffix: 'BASE_URL', file: 'servers', required: true },
  { field: 'reportArtifact', envSuffix: 'REPORT_ARTIFACT', file: 'servers', default: DEFAULT_REPORT_ARTIFACT },
  ...CREDENTIAL_FIELDS
];

export function serverEnvName(serverName: string, suffix: string): string {
  const normalized = serverName.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return `QA_RUN_TRIAGE_SERVER_${normalized}_${suffix}`;
}

export function fieldByName(name: string): FieldSpec {
  const spec = CONFIG_FIELDS.find((field) => field.name === name);
  if (!spec) {
    throw new Error(`Внутренняя ошибка: неизвестное поле схемы настроек ${name}.`);
  }
  return spec;
}

function readFieldPath(source: Record<string, unknown>, name: string): unknown {
  if (!name.includes('.')) {
    return source[name];
  }
  const [section, key] = name.split('.');
  const sectionValue = source[section];
  if (!sectionValue || typeof sectionValue !== 'object' || Array.isArray(sectionValue)) {
    return undefined;
  }
  return (sectionValue as Record<string, unknown>)[key];
}

export function resolveField(
  spec: FieldSpec,
  env: NodeJS.ProcessEnv,
  file: ProfileFile
): FieldResolution {
  if (spec.envName !== undefined && env[spec.envName] !== undefined) {
    return { value: coerceEnvValue(spec, env[spec.envName]!), source: 'env' };
  }
  const fileValue = readFieldPath(file as unknown as Record<string, unknown>, spec.name) as FieldValue;
  if (fileValue !== undefined) {
    return { value: fileValue, source: 'file' };
  }
  return { value: spec.default, source: 'default' };
}

function coerceEnvValue(spec: FieldSpec, raw: string): string | number {
  if (spec.name === 'report.timeZone') assertReportTimeZone(raw);
  if (spec.type === 'number') {
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
      throw new Error(
        `Переменная ${spec.envName} должна быть положительным целым числом в десятичной записи, получено "${raw}".`
      );
    }
    return Number(raw);
  }
  if (spec.enum && !spec.enum.includes(raw)) {
    throw new Error(
      `Переменная ${spec.envName} должна быть одним из: ${spec.enum.join(', ')}, получено "${raw}".`
    );
  }
  return raw;
}

export function homeStateDir(): string {
  return path.join(os.homedir(), '.qa-run-triage');
}

export function commonFilePath(): string {
  return path.join(homeStateDir(), 'config.json');
}

export function profileDir(name: string): string {
  return path.join(homeStateDir(), 'profiles', name);
}

export function profileJsonPath(name: string): string {
  return path.join(profileDir(name), 'profile.json');
}

export function credentialsJsonPath(name: string): string {
  return path.join(profileDir(name), 'credentials.json');
}

export function notesFilePathForDir(dir: string): string {
  return path.join(dir, 'notes.md');
}

function sectionDefaults(prefix: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const spec of CONFIG_FIELDS) {
    if (spec.default === undefined || !spec.name.startsWith(prefix)) {
      continue;
    }
    result[spec.name.slice(prefix.length)] = spec.default;
  }
  return result;
}

export function buildDefaultProfileContents(): Record<string, unknown> {
  return {
    description: '',
    servers: {
      [DEFAULT_SERVER_NAME]: { kind: SERVER_KINDS[0], auth: 'basic', reportArtifact: DEFAULT_REPORT_ARTIFACT }
    },
    repos: [],
    environment: DEFAULT_ENVIRONMENT,
    allowedJobs: [],
    report: sectionDefaults('report.'),
    limits: sectionDefaults('limits.')
  };
}

export function buildDefaultCredentialsContents(): Record<string, unknown> {
  return {};
}

export function buildDefaultCommonContents(): Record<string, unknown> {
  return { profile: 'default' };
}
