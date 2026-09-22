import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';

describe('--config указывает на файл секретов вместо профиля', () => {
  it('содержимое и ключи секретов не попадают в сообщение об ошибке', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-config-'));
    const file = path.join(dir, 'credentials.json');
    writeFileSync(
      file,
      JSON.stringify({ main: { proxyUser: 'ci_reader', proxyPass: 'совершенно_секретный_пароль' } }),
      'utf8'
    );
    let error: unknown;
    try {
      loadConfig({}, file);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    let current: unknown = error;
    while (current instanceof Error) {
      expect(current.message).not.toContain('совершенно_секретный_пароль');
      expect(current.message).not.toContain('ci_reader');
      current = current.cause;
    }
  });
});
