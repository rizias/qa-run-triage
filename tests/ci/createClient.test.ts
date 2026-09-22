import { resolveServer } from '../../src/serverResolution.js';
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { createCiClient } from '../../src/ci/createClient.js';
import { DEFAULT_ENVIRONMENT } from '../../src/configFields.js';
import { DEFAULT_SETTINGS } from '../../src/settings.js';
import type { Config } from '../../src/config.js';

function config(kind: string): Config {
  return {
    servers: {
      main: {
        ...resolveServer('main', {}, undefined, {}),
        kind,
        kindSource: 'file',
        baseUrl: 'https://ci.example',
        baseUrlSource: 'file',
        reportArtifact: 'allure-report.zip',
        reportArtifactSource: 'default',
        workspaceNodeMax: 40,
        workspaceNodeMaxSource: 'default',
        proxyUser: 'reader',
        proxyUserSet: true,
        proxyUserSource: 'file',
        proxyPass: 'secret',
        proxyPassSet: true,
        proxyPassSource: 'file'
      }
    },
    cacheDir: path.join('cache'),
    repos: [],
    environment: DEFAULT_ENVIRONMENT,
    settings: { ...DEFAULT_SETTINGS },
    profileName: 'default',
    profileSource: 'default',
    description: '',
    profileFile: '/profile.json',
    profileFileFound: true,
    credentialsFile: '/credentials.json'
  };
}

describe('Создание клиента CI', () => {
  it('отвергает неизвестный вид, называя поле и поддерживаемые значения', () => {
    expect(() => createCiClient(config('github'), 'main')).toThrow(
      /servers\.main\.kind.*github.*jenkins/
    );
  });
});
