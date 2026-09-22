import { afterEach, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { readStandardInput } from '../../src/cli/index.js';

const originalStdin = process.stdin;

function stubStdin(chunks: string[]): void {
  Object.defineProperty(process, 'stdin', {
    value: Readable.from(chunks),
    configurable: true
  });
}

afterEach(() => {
  Object.defineProperty(process, 'stdin', { value: originalStdin, configurable: true });
});

describe('Чтение стандартного ввода', () => {
  it('собирает многочастный ввод целиком', async () => {
    stubStdin(['{"job"', ':"backend/smoke"', ',"build":7}']);

    await expect(readStandardInput(1_048_576)).resolves.toBe('{"job":"backend/smoke","build":7}');
  });

  it('сообщает об отсутствии ввода, когда стандартный ввод пуст', async () => {
    stubStdin([]);

    await expect(readStandardInput(1_048_576)).rejects.toThrow('Разбор не передан');
  });

  it('останавливает чтение и называет предел, когда вход больше limits.journalInputMaxBytes', async () => {
    stubStdin(['a'.repeat(5), 'b'.repeat(5), 'c'.repeat(5)]);

    await expect(readStandardInput(10)).rejects.toThrow(
      'limits.journalInputMaxBytes (10 байт)'
    );
  });
});
