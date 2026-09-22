import { serverEnvName, type CredentialsEntry, type CredentialsFile, type ServerSpec } from './configFields.js';
import { isPlainObject } from './jsonGuards.js';

export const AUTH_MODES = ['none', 'basic', 'token'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export type ServerAuthentication =
  | { readonly auth: 'none' }
  | { readonly auth?: 'basic'; readonly proxyUser: string; readonly proxyPass: string }
  | { readonly auth: 'token'; readonly user: string; readonly token: string };

export function serverAuthentication(auth: AuthMode, credentials: CredentialsEntry): ServerAuthentication {
  if (auth === 'none') return { auth };
  if (auth === 'token') return { auth, user: credentials.user!, token: credentials.token! };
  return { auth, proxyUser: credentials.proxyUser!, proxyPass: credentials.proxyPass! };
}

export const CREDENTIAL_FIELDS = [
  { field: 'proxyUser', envSuffix: 'PROXY_USER', file: 'credentials', secret: true },
  { field: 'proxyPass', envSuffix: 'PROXY_PASS', file: 'credentials', secret: true },
  { field: 'user', envSuffix: 'USER', file: 'credentials', secret: true },
  { field: 'token', envSuffix: 'TOKEN', file: 'credentials', secret: true }
] as const;

export function credentialFields(auth: AuthMode): readonly (keyof CredentialsEntry)[] {
  if (auth === 'none') return [];
  return auth === 'basic' ? ['proxyUser', 'proxyPass'] : ['user', 'token'];
}

export function parseAuthMode(value: unknown, field: string): AuthMode {
  if (typeof value !== 'string' || !AUTH_MODES.includes(value as AuthMode)) {
    throw new Error(`Поле ${field} должно быть одним из: ${AUTH_MODES.join(', ')}.`);
  }
  return value as AuthMode;
}

export function assertCredentialMode(
  name: string,
  auth: AuthMode,
  credentials: CredentialsEntry | undefined,
  env: NodeJS.ProcessEnv
): void {
  if (auth === 'none') return;
  const allowed = credentialFields(auth);
  for (const { field, envSuffix } of CREDENTIAL_FIELDS) {
    if (!allowed.includes(field) && (credentials?.[field] !== undefined || env[serverEnvName(name, envSuffix)] !== undefined)) {
      throw new Error(`Сервер "${name}", режим ${auth}: поле ${name}.${field} недопустимо для этого режима.`);
    }
  }
}

export function validateCredentialsFile(
  parsed: unknown,
  file: string,
  servers: Record<string, ServerSpec>,
  env: NodeJS.ProcessEnv
): CredentialsFile {
  if (!isPlainObject(parsed)) throw new Error(`Файл секретов ${file} должен содержать объект JSON.`);
  const result: CredentialsFile = Object.create(null) as CredentialsFile;
  for (const [name, entry] of Object.entries(parsed)) {
    if (!Object.hasOwn(servers, name)) {
      throw new Error(`Файл секретов ${file}: запись ссылается на сервер, которого нет в servers файла профиля.`);
    }
    const envName = serverEnvName(name, 'AUTH');
    const auth = parseAuthMode(env[envName] ?? servers[name].auth ?? 'basic', `servers.${name}.auth (${envName})`);
    result[name] = auth === 'none' ? {} : validateCredentialsEntry(name, entry, file, auth);
  }
  return result;
}

function validateCredentialsEntry(name: string, value: unknown, file: string, auth: AuthMode): CredentialsEntry {
  if (!isPlainObject(value)) throw new Error(`Файл секретов ${file}: запись сервера "${name}" должна быть объектом.`);
  const result: CredentialsEntry = {};
  for (const key of Object.keys(value)) {
    const spec = CREDENTIAL_FIELDS.find(({ field }) => field === key);
    if (!spec) throw new Error(`Файл секретов ${file}: сервер "${name}", неизвестное поле.`);
    if (!credentialFields(auth).includes(spec.field)) {
      throw new Error(`Файл секретов ${file}: сервер "${name}", режим ${auth}: поле ${name}.${key} недопустимо для этого режима.`);
    }
    if (typeof value[key] !== 'string') {
      throw new Error(`Файл секретов ${file}: поле ${name}.${key} должно быть строкой.`);
    }
    result[spec.field] = value[key];
  }
  return result;
}
