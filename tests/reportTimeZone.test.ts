import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { describeConfig } from '../src/configDescribe.js';
import { runConfigShow } from '../src/cli/config/show.js';

function profile(report?: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'qa-report-zone-'));
  const file = path.join(dir, 'profile.json');
  writeFileSync(file, JSON.stringify({ report }));
  return file;
}

describe('Часовой пояс отчёта из спецификации настроек', () => {
  it('берёт пояс машины при отсутствии настройки', () => {
    const file = profile();
    const machine = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(loadConfig({}, file).settings.reportTimeZone).toBe(machine);
    expect(describeConfig({}, file).report.timeZone).toEqual({ name: 'report.timeZone', value: machine, source: 'default' });
  });

  it('читает явный пояс профиля и показывает его в config', () => {
    const file = profile({ timeZone: 'Asia/Tokyo' });
    expect(loadConfig({}, file).settings.reportTimeZone).toBe('Asia/Tokyo');
    expect(describeConfig({}, file).report.timeZone).toMatchObject({ value: 'Asia/Tokyo', source: 'file' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      runConfigShow({}, file, undefined, false);
      expect(log.mock.calls.flat().join('\n')).toContain('report.timeZone: Asia/Tokyo (источник: file)');
    } finally { log.mockRestore(); }
  });

  it('переменная часового пояса перекрывает файл', () => {
    const file = profile({ timeZone: 'Etc/UTC' });
    const env = { QA_RUN_TRIAGE_REPORT_TIME_ZONE: 'Asia/Tokyo' };
    expect(loadConfig(env, file).settings.reportTimeZone).toBe('Asia/Tokyo');
    expect(describeConfig(env, file).report.timeZone).toMatchObject({ value: 'Asia/Tokyo', source: 'env' });
  });

  it.each(['', 'Unknown/Zone', 42])('отвергает неверный пояс файла %j с именем поля', (timeZone) => {
    expect(() => loadConfig({}, profile({ timeZone }))).toThrow('report.timeZone');
  });

  it.each(['', 'Unknown/Zone'])('отвергает неверный пояс окружения %j с именем поля', (timeZone) => {
    const file = profile({ timeZone: 'Etc/UTC' });
    expect(() => loadConfig({ QA_RUN_TRIAGE_REPORT_TIME_ZONE: timeZone }, file)).toThrow('report.timeZone');
    expect(() => describeConfig({ QA_RUN_TRIAGE_REPORT_TIME_ZONE: timeZone }, file)).toThrow('report.timeZone');
  });
});
