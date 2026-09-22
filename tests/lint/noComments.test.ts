import { ESLint, type Linter } from 'eslint';
import { describe, expect, it } from 'vitest';

const configPath: string = '../../eslint.config.js';
const configModule = await import(configPath) as unknown as {
  buildConfig: (ownerPaths: string[]) => Linter.Config[];
};
const { buildConfig } = configModule;
const eslint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: buildConfig([]),
});

async function lintText(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return result;
}

describe('Запрет комментариев в коде', () => {
  it('сообщает об обычном комментарии', async () => {
    const result = await lintText('// note\nexport const value = 1;', 'a.js');

    expect(result.errorCount).toBe(1);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].ruleId).toBe('local/no-comments');
  });

  it('директива отключения не скрывает комментарий', async () => {
    const result = await lintText(
      '// eslint-disable-next-line local/no-comments\n// prose\nexport const value = 1;',
      'a.js',
    );

    const lines = result.messages.filter(({ ruleId }) => ruleId === 'local/no-comments').map(({ line }) => line);
    expect(lines).toEqual([1, 2]);
    expect(result.suppressedMessages).toHaveLength(0);
  });

  it('разрешает строку запуска интерпретатора', async () => {
    const result = await lintText('#!/usr/bin/env node\nexport const value = 1;', 'a.js');

    expect(result.errorCount).toBe(0);
  });

  it('разрешает директиву ошибки TypeScript', async () => {
    const result = await lintText(
      '// @ts-expect-error: reason\nexport const value = 1;',
      'a.js',
    );

    expect(result.messages.filter(({ ruleId }) => ruleId === 'local/no-comments')).toHaveLength(0);
  });

  it('разрешает отметку владельца', async () => {
    const result = await lintText('// owner: reason\nexport const value = 1;', 'a.js');

    expect(result.messages.filter(({ ruleId }) => ruleId === 'local/no-comments')).toHaveLength(0);
  });
});
