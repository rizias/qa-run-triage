import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createCiClient } from '../src/ci/createClient.js';
import { runConfigShow } from '../src/cli/config/show.js';
import type { ConfigDescription } from '../src/configDescribe.js';

function profile(auth: unknown, credentials?: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'qa-auth-'));
  const file = path.join(dir, 'profile.json');
  writeFileSync(file, JSON.stringify({ servers: { main: { baseUrl: 'https://ci.example', auth } } }));
  if (credentials !== undefined) writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify(credentials));
  return file;
}

function show(file: string, env: NodeJS.ProcessEnv = {}, json = false): string {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    runConfigShow(env, file, undefined, json);
    return log.mock.calls.flat().join('\n');
  } finally {
    log.mockRestore();
  }
}

const secrets = {
  none: {},
  basic: { proxyUser: 'пример-пользователя', proxyPass: 'пример-пароля' },
  token: { user: 'пример-пользователя', token: 'пример-токена' }
};

const required = [
  ['basic', 'proxyUser', 'PROXY_USER'],
  ['basic', 'proxyPass', 'PROXY_PASS'],
  ['token', 'user', 'USER'],
  ['token', 'token', 'TOKEN']
] as const;

describe('Режим аутентификации сервера из спецификации настроек', () => {
  it('сохраняет basic для прежнего профиля без auth', () => {
    const file = profile(undefined, { main: secrets.basic });
    expect(loadConfig({}, file).servers.main).toMatchObject({ auth: 'basic', authSource: 'default' });
    expect(() => createCiClient(loadConfig({}, file), 'main')).not.toThrow();
  });

  it.each([undefined, {}])('none работает без файла секретов или записи сервера: %j', (credentials) => {
    const file = profile('none', credentials);
    expect(() => createCiClient(loadConfig({}, file), 'main')).not.toThrow();
  });

  it.each([null, 'остаточная запись', { ...secrets.basic, ...secrets.token, опечатка: 42 }, { proxyUser: 42 }])(
    'none игнорирует содержимое записи секретов: %j', (entry) => {
      const file = profile('none', { main: entry });
      expect(() => createCiClient(loadConfig({}, file), 'main')).not.toThrow();
      expect(show(file)).not.toMatch(/main\.(proxyUser|proxyPass|user|token)/);
    }
  );

  it.each(required)('%s требует %s и называет переменную %s', (auth, field, suffix) => {
    const entry: Record<string, string> = { ...secrets[auth] };
    delete entry[field];
    const file = profile(auth, { main: entry });
    expect(() => createCiClient(loadConfig({}, file), 'main')).toThrow(
      new RegExp(`main.*режим ${auth}.*QA_RUN_TRIAGE_SERVER_MAIN_${suffix}.*main\\.${field}`)
    );
  });

  it.each(required)('%s считает пустое значение %s из окружения отсутствующим для сети', (auth, field, suffix) => {
    const file = profile(auth, { main: secrets[auth] });
    const env = { [`QA_RUN_TRIAGE_SERVER_MAIN_${suffix}`]: '' };
    expect(() => createCiClient(loadConfig(env, file), 'main')).toThrow(`main.${field}`);
    expect(show(file, env)).toContain(`main.${field}: задан`);
  });

  it.each(['basic', 'token'] as const)('%s требует оба поля при отсутствии записи секретов', (auth) => {
    const file = profile(auth);
    let message = '';
    try { createCiClient(loadConfig({}, file), 'main'); } catch (error) { message = (error as Error).message; }
    for (const [mode, field, suffix] of required.filter(([mode]) => mode === auth)) {
      expect(message).toContain(`режим ${mode}`);
      expect(message).toContain(`main.${field}`);
      expect(message).toContain(`QA_RUN_TRIAGE_SERVER_MAIN_${suffix}`);
    }
  });

  it.each(['none', 'basic', 'token'] as const)('окружение выбирает %s поверх режима файла', (auth) => {
    const file = profile('none', { main: secrets[auth] });
    const env = { QA_RUN_TRIAGE_SERVER_MAIN_AUTH: auth };
    expect(loadConfig(env, file).servers.main).toMatchObject({ auth, authSource: 'env' });
    expect(() => createCiClient(loadConfig(env, file), 'main')).not.toThrow();
  });

  it.each(['', 'другой', 42])('отвергает неверный режим файла %j', (auth) => {
    expect(() => loadConfig({}, profile(auth))).toThrow(/servers\.main\.auth.*none, basic, token/);
  });

  it.each(['', 'другой'])('отвергает неверный режим окружения %j', (auth) => {
    expect(() => loadConfig({ QA_RUN_TRIAGE_SERVER_MAIN_AUTH: auth }, profile('basic')))
      .toThrow(/QA_RUN_TRIAGE_SERVER_MAIN_AUTH.*none, basic, token/);
  });
});

describe('Поля другого режима из спецификации настроек', () => {
  it.each(required)('отклоняет поле %s / %s из файла и окружения', (ownMode, field, suffix) => {
    const auth = ownMode === 'basic' ? 'token' : 'basic';
    const file = profile(auth, { main: { ...secrets[auth], [field]: '' } });
    expect(() => loadConfig({}, file)).toThrow(new RegExp(`main.*${auth}.*main\\.${field}`));
    const withoutForeign = profile(auth, { main: secrets[auth] });
    expect(() => loadConfig({ [`QA_RUN_TRIAGE_SERVER_MAIN_${suffix}`]: '' }, withoutForeign))
      .toThrow(new RegExp(`main.*${auth}.*main\\.${field}`));
  });
});

describe('Вывод config по режиму из спецификации настроек', () => {
  it.each(['none', 'basic', 'token'] as const)('%s показывает только свои признаки секретов', (auth) => {
    const file = profile(auth, { main: secrets[auth] });
    const text = show(file);
    const json = show(file, {}, true);
    const shown = (JSON.parse(json) as ConfigDescription).servers[0];
    expect(shown.auth).toMatchObject({ value: auth, source: 'file' });
    expect(text).toContain(`main.auth: ${auth}`);
    for (const [mode, field] of required) {
      if (mode === auth) {
        expect(text).toContain(`main.${field}: задан`);
        expect(shown[field]).toEqual({ name: field, source: 'file', set: true });
      } else {
        expect(shown).not.toHaveProperty(field);
        expect(text).not.toContain(`main.${field}:`);
      }
    }
    expect(text + json).not.toMatch(/пример-(пользователя|пароля|токена)/);
  });

  it.each(['basic', 'token'] as const)('%s показывает незаданные секреты без ошибки', (auth) => {
    const file = profile(auth);
    const text = show(file);
    const shown = (JSON.parse(show(file, {}, true)) as ConfigDescription).servers[0];
    for (const [, field] of required.filter(([mode]) => mode === auth)) {
      expect(text).toContain(`main.${field}: не задан`);
      expect(shown[field]).toMatchObject({ set: false, source: 'default' });
    }
  });
});
