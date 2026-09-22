import { existsSync } from 'node:fs';
import { readCommonFile } from './commonConfig.js';
import {
  CONFIG_FIELDS,
  DEFAULT_ENVIRONMENT,
  fieldByName,
  resolveField,
  type CredentialsEntry,
  type EnvironmentConfig,
  type FieldSource,
  type JobGroupSpec,
  type ProfileFile,
  type ServerSpec
} from './configFields.js';
import { notesFilePath, readProfileFile, resolveCacheDir, type ProfileSource } from './config.js';
import { resolveServer } from './serverResolution.js';
import { maskUrlUserinfo } from './safeUrl.js';
import { credentialFields } from './serverAuth.js';

export interface ConfigFieldDescription {
  readonly name: string;
  readonly source: FieldSource;
  readonly value?: string | number | readonly string[] | Readonly<Record<string, JobGroupSpec>> | EnvironmentConfig;
  readonly set?: boolean;
}

export interface ServerDescription {
  readonly name: string;
  readonly kind: ConfigFieldDescription;
  readonly auth: ConfigFieldDescription;
  readonly baseUrl: ConfigFieldDescription;
  readonly reportArtifact: ConfigFieldDescription;
  readonly workspaceNodeMax: ConfigFieldDescription;
  readonly proxyUser?: ConfigFieldDescription;
  readonly proxyPass?: ConfigFieldDescription;
  readonly user?: ConfigFieldDescription;
  readonly token?: ConfigFieldDescription;
}

export interface ConfigDescription {
  readonly commonFile: string;
  readonly commonFileFound: boolean;
  readonly profileName: string;
  readonly profileSource: ProfileSource;
  readonly profileFile: string;
  readonly profileFileFound: boolean;
  readonly credentialsFile: string;
  readonly credentialsFileFound: boolean;
  readonly notesFile: string;
  readonly notesFileFound: boolean;
  readonly description: ConfigFieldDescription;
  readonly servers: readonly ServerDescription[];
  readonly jobs: ConfigFieldDescription;
  readonly defaultServer: ConfigFieldDescription;
  readonly repos: ConfigFieldDescription;
  readonly environment: ConfigFieldDescription;
  readonly allowedJobs: ConfigFieldDescription;
  readonly report: { readonly timeZone: ConfigFieldDescription };
  readonly limits: readonly ConfigFieldDescription[];
  readonly cacheDir: ConfigFieldDescription;
}

function describeField(name: string, env: NodeJS.ProcessEnv, file: ProfileFile): ConfigFieldDescription {
  const spec = fieldByName(name);
  const { value, source } = resolveField(spec, env, file);
  if (spec.type === 'stringArray') {
    return { name: spec.name, source, value: value ?? [] };
  }
  return { name: spec.name, source, value: value ?? '' };
}

function describeServer(
  name: string,
  spec: ServerSpec,
  credentials: CredentialsEntry | undefined,
  env: NodeJS.ProcessEnv
): ServerDescription {
  const resolved = resolveServer(name, spec, credentials, env);
  return {
    name,
    kind: { name: 'kind', source: resolved.kindSource, value: resolved.kind },
    auth: { name: 'auth', source: resolved.authSource, value: resolved.auth },
    baseUrl: { name: 'baseUrl', source: resolved.baseUrlSource, value: maskUrlUserinfo(resolved.baseUrl) },
    reportArtifact: { name: 'reportArtifact', source: resolved.reportArtifactSource, value: resolved.reportArtifact },
    workspaceNodeMax: {
      name: 'workspaceNodeMax',
      source: resolved.workspaceNodeMaxSource,
      value: resolved.workspaceNodeMax
    },
    ...Object.fromEntries(credentialFields(resolved.auth).map((field) => [field, {
      name: field, source: resolved[`${field}Source`], set: resolved[`${field}Set`]
    }]))
  };
}

function describeCacheDir(env: NodeJS.ProcessEnv, selection: Parameters<typeof resolveCacheDir>[1]): ConfigFieldDescription {
  const resolved = resolveCacheDir(env, selection);
  return { name: 'cacheDir', source: resolved.source, value: resolved.value };
}

function describeDefaultServer(file: ProfileFile): ConfigFieldDescription {
  if (file.defaultServer !== undefined) {
    return { name: 'defaultServer', source: 'file', value: file.defaultServer };
  }
  const names = Object.keys(file.servers ?? {});
  if (names.length === 1) {
    return { name: 'defaultServer', source: 'default', value: names[0] };
  }
  return { name: 'defaultServer', source: 'default', value: '' };
}

export function describeConfig(
  env: NodeJS.ProcessEnv = process.env,
  explicitConfigFile?: string,
  explicitProfile?: string,
  cwd?: string
): ConfigDescription {
  const common = readCommonFile();
  const read = readProfileFile(env, explicitConfigFile, explicitProfile, cwd);
  const notes = notesFilePath(read.selection);
  const servers = Object.entries(read.file.servers ?? {}).map(([name, spec]) =>
    describeServer(name, spec, read.credentials[name], env)
  );
  return {
    commonFile: common.path,
    commonFileFound: common.found,
    profileName: read.selection.profileName,
    profileSource: read.selection.source,
    profileFile: read.path,
    profileFileFound: read.found,
    credentialsFile: read.credentialsPath,
    credentialsFileFound: existsSync(read.credentialsPath),
    notesFile: notes,
    notesFileFound: existsSync(notes),
    description: describeField('description', env, read.file),
    servers,
    jobs: {
      name: 'jobs',
      source: read.file.jobs === undefined ? 'default' : 'file',
      value: read.file.jobs ?? {}
    },
    defaultServer: describeDefaultServer(read.file),
    repos: {
      name: 'repos',
      source: read.file.repos === undefined ? 'default' : 'file',
      value: read.file.repos ?? []
    },
    environment: {
      name: 'environment',
      source: read.file.environment === undefined ? 'default' : 'file',
      value: read.file.environment ?? DEFAULT_ENVIRONMENT
    },
    allowedJobs: describeField('allowedJobs', env, read.file),
    report: { timeZone: describeField('report.timeZone', env, read.file) },
    limits: CONFIG_FIELDS.filter((field) => field.name.startsWith('limits.')).map((field) =>
      describeField(field.name, env, read.file)
    ),
    cacheDir: describeCacheDir(env, read.selection)
  };
}
