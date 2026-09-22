import { readFileSync } from 'node:fs';

export function readSecretJson(file: string, kind = 'секретов'): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return fail(file, 'не определена', kind);
  }
  return parseJsonSafely(file, text, kind);
}

export function parseJsonSafely(file: string, text: string, kind = 'секретов'): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const position = /position (\d+)/.exec(message)?.[1] ?? String(findPosition(text));
    return fail(file, position, kind);
  }
}

function fail(file: string, position: string, kind: string): never {
  throw new Error(`Файл ${kind} ${file}: ошибка чтения JSON, позиция ${position}.`);
}

function findPosition(text: string): number {
  let cursor = 0;
  const whitespace = (): void => { while (/[\t\r\n ]/.test(text[cursor] ?? 'x')) cursor++; };
  const take = (character: string): void => {
    whitespace();
    if (text[cursor] !== character) throw new Error('Позиция найдена');
    cursor++;
  };
  const string = (): void => {
    whitespace();
    const token = /"(?:[^"\\]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"/y;
    token.lastIndex = cursor;
    if (!token.test(text)) throw new Error('Позиция найдена');
    cursor = token.lastIndex;
  };
  const sequence = (end: string, object: boolean): void => {
    cursor++;
    whitespace();
    if (text[cursor] === end) { cursor++; return; }
    for (;;) {
      if (object) { string(); take(':'); }
      value();
      whitespace();
      if (text[cursor] === end) { cursor++; return; }
      take(',');
    }
  };
  const value = (): void => {
    whitespace();
    const next = text[cursor];
    if (next === '{') return sequence('}', true);
    if (next === '[') return sequence(']', false);
    if (next === '"') return string();
    const token = /(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
    token.lastIndex = cursor;
    if (!token.test(text)) throw new Error('Позиция найдена');
    cursor = token.lastIndex;
  };
  try { value(); whitespace(); } catch { return cursor; }
  return cursor;
}
