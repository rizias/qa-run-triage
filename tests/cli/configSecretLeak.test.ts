import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const cli = path.resolve('dist', 'cli', 'index.js');
const secretFragment = 'TOPSEC';

function runCli(args: string[], home: string): string {
  const result = spawnSync(process.execPath, [cli, ...args], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      QA_RUN_TRIAGE_PROFILE: undefined,
      QA_RUN_TRIAGE_CACHE_DIR: undefined
    },
    encoding: 'utf8'
  });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

describe('Ошибка разбора JSON загрузчиков настроек не печатает фрагмент секрета', () => {
  it('файл профиля, переданный через --config, с битым JSON', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-leak-profile-'));
    const home = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-leak-home-'));
    const file = path.join(dir, 'profile.json');
    writeFileSync(file, '{"main":{"proxyPass":TOPSECRET999}}', 'utf8');

    const out = runCli(['config', '--config', file], home);

    expect(out).not.toContain(secretFragment);
  });

  it('файл секретов рядом с профилем, с битым JSON', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-leak-creds-'));
    const home = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-leak-home-'));
    writeFileSync(
      path.join(dir, 'profile.json'),
      JSON.stringify({ servers: { main: { kind: 'jenkins', baseUrl: 'http://example' } } }),
      'utf8'
    );
    writeFileSync(path.join(dir, 'credentials.json'), '{"main":{"proxyPass":TOPSECRET999}}', 'utf8');

    const out = runCli(['config', '--config', path.join(dir, 'profile.json')], home);

    expect(out).not.toContain(secretFragment);
  });

  it('общий config.json домашней папки, с битым JSON', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-leak-home-'));
    const stateDir = path.join(home, '.qa-run-triage');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, 'config.json'), '{"profile":TOPSECRET999}', 'utf8');

    const out = runCli(['config'], home);

    expect(out).not.toContain(secretFragment);
  });
});
