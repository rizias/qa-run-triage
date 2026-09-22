import { describe, expect, it, vi } from 'vitest';
import { printCliError } from '../../src/cli/printError.js';

describe('Вывод причин ошибки команды', () => {
  it('Ошибка CLI печатает цепочку причин', () => {
      const lines: string[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((line: string) => {
        lines.push(line);
      });
      try {
        printCliError(new Error('верх', { cause: new Error('низ') }));
        expect(lines[0]).toBe('верх');
        expect(lines[1]).toBe('Причина: низ');
      } finally {
        spy.mockRestore();
      }
    });

  it('userinfo URL в сообщении и в цепочке причин маскируется', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: string) => {
      lines.push(line);
    });
    try {
      printCliError(new Error(
        'не удалось подключиться к http://ci_reader:совершенно_секретный_пароль@jenkins.example/job',
        { cause: new Error('причина: http://ci_reader:совершенно_секретный_пароль@jenkins.example/job') }
      ));
      for (const line of lines) {
        expect(line).not.toContain('совершенно_секретный_пароль');
      }
    } finally {
      spy.mockRestore();
    }
  });
});
