import {
  DEFAULT_WORKSPACE_NODE_MAX,
  SERVER_FIELDS,
  serverEnvName,
  type CredentialsEntry,
  type CredentialsFile,
  type FieldSource,
  type JobGroupSpec,
  type ServerFieldName,
  type ServerFieldSpec,
  type ServerSpec
} from './configFields.js';
import { resolveJobSettings } from './jobs.js';
import { assertBaseUrl } from './safeUrl.js';
import { assertCredentialMode, CREDENTIAL_FIELDS, credentialFields, parseAuthMode, serverAuthentication, type AuthMode, type ServerAuthentication } from './serverAuth.js';

export interface ResolvedServer {
  readonly kind: string;
  readonly kindSource: FieldSource;
  readonly auth: AuthMode;
  readonly authSource: FieldSource;
  readonly baseUrl: string;
  readonly baseUrlSource: FieldSource;
  readonly reportArtifact: string;
  readonly reportArtifactSource: FieldSource;
  readonly workspaceNodeMax: number;
  readonly workspaceNodeMaxSource: FieldSource;
  readonly proxyUser: string;
  readonly proxyUserSet: boolean;
  readonly proxyUserSource: FieldSource;
  readonly proxyPass: string;
  readonly proxyPassSet: boolean;
  readonly proxyPassSource: FieldSource;
  readonly user: string;
  readonly userSet: boolean;
  readonly userSource: FieldSource;
  readonly token: string;
  readonly tokenSet: boolean;
  readonly tokenSource: FieldSource;
}

interface FieldResolution {
  readonly value: string;
  readonly source: FieldSource;
}

function resolveServerField(
  spec: ServerFieldSpec,
  serverName: string,
  server: ServerSpec,
  credentials: CredentialsEntry | undefined,
  env: NodeJS.ProcessEnv
): FieldResolution {
  const envName = serverEnvName(serverName, spec.envSuffix);
  const envValue = env[envName];
  if (envValue !== undefined) {
    if (spec.enum && !spec.enum.includes(envValue)) {
      throw new Error(
        `Переменная ${envName} должна быть одной из: ${spec.enum.join(', ')}, получено "${envValue}".`
      );
    }
    return { value: envValue, source: 'env' };
  }
  const fileValue = spec.file === 'servers'
    ? server[spec.field as 'kind' | 'auth' | 'baseUrl' | 'reportArtifact']
    : credentials?.[spec.field as keyof CredentialsEntry];
  if (fileValue !== undefined) {
    return { value: fileValue, source: 'file' };
  }
  return { value: spec.default ?? '', source: 'default' };
}

export function resolveServer(
  name: string,
  server: ServerSpec,
  credentials: CredentialsEntry | undefined,
  env: NodeJS.ProcessEnv
): ResolvedServer {
  const authEnv = serverEnvName(name, 'AUTH');
  const auth = parseAuthMode(env[authEnv] ?? server.auth ?? 'basic', `servers.${name}.auth (${authEnv})`);
  assertCredentialMode(name, auth, credentials, env);
  const values = Object.fromEntries(
    SERVER_FIELDS.map((spec) => [spec.field,
      spec.secret && !credentialFields(auth).includes(spec.field as keyof CredentialsEntry)
        ? { value: '', source: 'default' }
        : resolveServerField(spec, name, server, credentials, env)])
  ) as Record<ServerFieldName, FieldResolution>;
  const workspaceNodeMax = resolveWorkspaceNodeMax(name, server, values.kind.value, env);
  assertReportArtifact(name, values.reportArtifact.value);
  assertBaseUrl(values.baseUrl.value, values.baseUrl.source === 'env' ? serverEnvName(name, 'BASE_URL') : `servers.${name}.baseUrl`);
  return {
    kind: values.kind.value,
    kindSource: values.kind.source,
    auth,
    authSource: values.auth.source,
    baseUrl: values.baseUrl.value.replace(/\/+$/, ''),
    baseUrlSource: values.baseUrl.source,
    reportArtifact: values.reportArtifact.value,
    reportArtifactSource: values.reportArtifact.source,
    workspaceNodeMax: workspaceNodeMax.value,
    workspaceNodeMaxSource: workspaceNodeMax.source,
    proxyUser: values.proxyUser.value,
    proxyUserSet: values.proxyUser.source === 'env' || Boolean(values.proxyUser.value),
    proxyUserSource: values.proxyUser.source,
    proxyPass: values.proxyPass.value,
    proxyPassSet: values.proxyPass.source === 'env' || Boolean(values.proxyPass.value),
    proxyPassSource: values.proxyPass.source,
    user: values.user.value,
    userSet: values.user.source === 'env' || Boolean(values.user.value),
    userSource: values.user.source,
    token: values.token.value,
    tokenSet: values.token.source === 'env' || Boolean(values.token.value),
    tokenSource: values.token.source
  };
}

export function assertReportArtifact(name: string, value: string): void {
  if (!value || value === '.' || value.includes('..') || /[\\/:\p{Cc}]/u.test(value)) {
    throw new Error(`Поле servers.${name}.reportArtifact должно быть простым именем файла без разделителей, диска, '..' и управляющих символов.`);
  }
}

function resolveWorkspaceNodeMax(
  name: string,
  server: ServerSpec,
  kind: string,
  env: NodeJS.ProcessEnv
): { value: number; source: FieldSource } {
  const envName = serverEnvName(name, 'WORKSPACE_NODE_MAX');
  const envValue = env[envName];
  const setInEnv = envValue !== undefined;
  const setInFile = server.workspaceNodeMax !== undefined;
  if (kind !== 'jenkins' && (setInEnv || setInFile)) {
    throw new Error(
      `Поле servers.${name}.workspaceNodeMax допустимо только для kind jenkins.`
    );
  }
  if (setInEnv) {
    if (!/^\d+$/.test(envValue) || Number(envValue) <= 0) {
      throw new Error(
        `Переменная ${envName} должна быть положительным целым числом в десятичной записи, получено "${envValue}".`
      );
    }
    return { value: Number(envValue), source: 'env' };
  }
  if (setInFile && server.workspaceNodeMax !== undefined) {
    return { value: server.workspaceNodeMax, source: 'file' };
  }
  return { value: DEFAULT_WORKSPACE_NODE_MAX, source: 'default' };
}

export function buildServers(
  env: NodeJS.ProcessEnv,
  servers: Record<string, ServerSpec> | undefined,
  credentials: CredentialsFile
): Record<string, ResolvedServer> {
  const result: Record<string, ResolvedServer> = Object.create(null) as Record<string, ResolvedServer>;
  for (const [name, spec] of Object.entries(servers ?? {})) {
    result[name] = resolveServer(name, spec, credentials[name], env);
  }
  return result;
}

export type RequiredServerConfig = ServerAuthentication & {
  readonly baseUrl: string;
  readonly reportArtifact: string;
};

export function resolveServerNameForJob(
  jobs: Readonly<Record<string, JobGroupSpec>> | undefined,
  defaultServer: string | undefined,
  serverNames: readonly string[],
  job: string
): string {
  const settings = resolveJobSettings(job, jobs);
  if (settings.server) {
    return settings.server;
  }
  if (defaultServer) {
    return defaultServer;
  }
  if (serverNames.length === 1) {
    return serverNames[0];
  }
  throw new Error(
    `Для джобы ${job} не задан сервер: заполните поле jobs.<ключ>.server покрывающей группы ` +
      `или поле ${settings.serverField} файла профиля.`
  );
}

export function resolveServerNameForJobLenient(
  jobs: Readonly<Record<string, JobGroupSpec>> | undefined,
  defaultServer: string | undefined,
  serverNames: readonly string[],
  job: string
): string | undefined {
  const settings = resolveJobSettings(job, jobs);
  if (settings.server) {
    return settings.server;
  }
  if (defaultServer) {
    return defaultServer;
  }
  if (serverNames.length === 1) {
    return serverNames[0];
  }
  return undefined;
}

export function requireServer(
  servers: Readonly<Record<string, ResolvedServer>>,
  serverName: string,
  profileFile: string,
  credentialsFile: string
): RequiredServerConfig {
  const server = servers[serverName];
  if (!server) {
    throw new Error(
      `Сервер "${serverName}" не объявлен в servers файла профиля ${profileFile}.`
    );
  }
  const missing: string[] = [];
  if (!server.baseUrl) {
    missing.push(`${serverEnvName(serverName, 'BASE_URL')} (поле servers.${serverName}.baseUrl файла ${profileFile})`);
  }
  for (const { field, envSuffix } of CREDENTIAL_FIELDS) {
    if (credentialFields(server.auth).includes(field) && !server[field]) {
      missing.push(`${serverEnvName(serverName, envSuffix)} (поле ${serverName}.${field} файла ${credentialsFile})`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Не заданы обязательные настройки сервера "${serverName}" (режим ${server.auth}): ${missing.join(', ')}.`);
  }
  return {
    baseUrl: server.baseUrl,
    ...serverAuthentication(server.auth, server),
    reportArtifact: server.reportArtifact
  };
}

export function lenientServerBaseUrl(
  servers: Readonly<Record<string, ResolvedServer>>,
  serverName: string | undefined
): string | null {
  if (!serverName) {
    return null;
  }
  return servers[serverName]?.baseUrl || null;
}
