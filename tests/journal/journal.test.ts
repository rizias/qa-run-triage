import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { appendEntry, readEntries, countFingerprint, withJournalLock, type JournalEntry, appendMissingEntries, type JournalEntryInput } from '../../src/journal/journal.js';

let cache: string;
const exactSignature = '  Token AbC-123\nSecond LINE  ';

function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    job: 'backend/all-tests',
    build: 30,
    analyzedAt: '2026-08-06T03:12:00.000Z',
    env: 'stage',
    city: 'spb',
    branch: '',
    codeBranch: 'main',
    result: 'FAILURE',
    testsRan: true,
    total: 370,
    failed: 2,
    recoveredAfterRetry: 2,
    verdict: 'зависла форма фиксации',
    fingerprints: [exactSignature],
    model: 'test',
    analysisDurationMs: 4000,
    buildTimestamp: null,
    durationMs: null,
    commit: null,
    buildUrl: null,
    tokensIn: 0,
    tokensOut: 0,
    ...overrides
  };
}

beforeEach(() => {
  cache = mkdtempSync(path.join(tmpdir(), 'journal-'));
});

afterEach(() => {
  rmSync(cache, { recursive: true, force: true });
});

describe('Запись журнала', () => {
  it('сохраняет запись и читает её обратно', () => {
    appendEntry(cache, entry());
    const result = readEntries(cache);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].verdict).toBe('зависла форма фиксации');
  });

  it('дописывает вторую запись, не затирая первую', () => {
    appendEntry(cache, entry());
    appendEntry(cache, entry({ build: 31 }));
    expect(readEntries(cache).entries).toHaveLength(2);
  });

  it('upsert-ит запись того же job+build на её месте', () => {
    appendEntry(cache, entry({ build: 29, verdict: 'первая' }));
    appendEntry(cache, entry({ build: 30, verdict: 'старая' }));
    appendEntry(cache, entry({ build: 31, verdict: 'третья' }));
    appendEntry(cache, entry({ build: 30, verdict: 'новая' }));

    expect(readEntries(cache).entries.map((item) => [item.build, item.verdict])).toEqual([
      [29, 'первая'],
      [30, 'новая'],
      [31, 'третья']
    ]);
  });

  it('folder/smoke и /folder/smoke/ считаются одним прогоном, строки не переписываются', () => {
    appendEntry(cache, entry({ job: 'folder/smoke', verdict: 'первая' }));
    appendEntry(cache, entry({ job: '/folder/smoke/', verdict: 'вторая' }));

    const result = readEntries(cache);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].verdict).toBe('вторая');

    const rawLines = readFileSync(path.join(cache, 'journal.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0);
    expect(rawLines).toHaveLength(1);
  });

  it('сохраняет русский текст без искажения', () => {
    appendEntry(cache, entry({ verdict: 'проверка кодировки' }));
    expect(readEntries(cache).entries[0].verdict).toBe('проверка кодировки');
  });

  it('сохраняет точную подпись и не добавляет версию новой записи', () => {
    appendEntry(cache, entry());
    const saved = readEntries(cache).entries[0];

    expect(Buffer.from(saved.fingerprints[0], 'utf8')).toEqual(Buffer.from(exactSignature, 'utf8'));
    expect(saved).not.toHaveProperty('signatureVersion');
  });

  it('записывает журнал через временный файл и атомарный rename', () => {
    appendEntry(cache, entry());
    expect(readdirSync(cache).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(readdirSync(cache)).toEqual(['journal.jsonl']);
  });

  it('сохраняет нечитаемую строку журнала', () => {
    const file = path.join(cache, 'journal.jsonl');
    writeFileSync(file, `${JSON.stringify(entry())}\nне JSON\n`, 'utf8');

    appendEntry(cache, entry({ build: 31 }));

    expect(readFileSync(file, 'utf8')).toContain('не JSON');
    expect(readEntries(cache).brokenLines).toEqual(['не JSON']);
  });

  it('оставляет нечитаемую строку на её месте', () => {
    const file = path.join(cache, 'journal.jsonl');
    writeFileSync(file, `не JSON\n${JSON.stringify(entry())}\n`, 'utf8');

    appendEntry(cache, entry({ build: 31 }));

    expect(readFileSync(file, 'utf8').split('\n')[0]).toBe('не JSON');
  });
});

describe('Блокировка журнала', () => {
  it('не пускает второго писателя, пока замок занят', () => {
    let entered = false;

    withJournalLock(cache, () => {
      expect(() =>
        withJournalLock(cache, () => {
          entered = true;
        }, { timeoutMs: 30 })
      ).toThrow(/замок/i);
    });

    expect(entered).toBe(false);
  });

  it('снимает замок после работы', () => {
    withJournalLock(cache, () => undefined);
    expect(existsSync(path.join(cache, 'journal.jsonl.lock'))).toBe(false);
  });

  it('снимает замок, даже если работа завершилась ошибкой', () => {
    expect(() =>
      withJournalLock(cache, () => {
        throw new Error('сбой записи');
      })
    ).toThrow('сбой записи');

    expect(existsSync(path.join(cache, 'journal.jsonl.lock'))).toBe(false);
  });
});

describe('Чтение журнала', () => {
  it('возвращает пустой список, когда журнала ещё нет', () => {
    expect(readEntries(cache)).toEqual({ entries: [], brokenLines: [] });
  });

  it('пропускает битую строку и возвращает счётчик пропусков', () => {
    writeFileSync(
      path.join(cache, 'journal.jsonl'),
      `${JSON.stringify(entry())}\nне JSON\n${JSON.stringify(entry({ build: 31 }))}\n`,
      'utf8'
    );

    expect(readEntries(cache).brokenLines).toHaveLength(1);
    expect(readEntries(cache).entries.map((item) => item.build)).toEqual([30, 31]);
  });

  it('возвращает текст нечитаемых строк, а не только их число', () => {
    writeFileSync(
      path.join(cache, 'journal.jsonl'),
      `не JSON\n${JSON.stringify(entry())}\n`,
      'utf8'
    );

    expect(readEntries(cache).brokenLines).toEqual(['не JSON']);
  });

  it('нормализует отсутствующие поля старой строки', () => {
    const legacy = { ...entry() } as Record<string, unknown>;
    delete legacy.buildTimestamp;
    delete legacy.durationMs;
    delete legacy.commit;
    delete legacy.buildUrl;
    delete legacy.tokensIn;
    delete legacy.tokensOut;
    writeFileSync(path.join(cache, 'journal.jsonl'), `${JSON.stringify(legacy)}\n`, 'utf8');

    expect(readEntries(cache).entries[0]).toMatchObject({
      buildTimestamp: null,
      durationMs: null,
      commit: null,
      buildUrl: null,
      tokensIn: 0,
      tokensOut: 0
    });
  });

  it('читает jenkinsUrl и buildUrl как адрес прогона', () => {
    const withLegacy = { ...entry(), buildUrl: undefined, jenkinsUrl: 'https://ci.example/old' };
    delete (withLegacy as { buildUrl?: string | null }).buildUrl;
    const withNew = entry({ build: 31, buildUrl: 'https://ci.example/new' });
    writeFileSync(
      path.join(cache, 'journal.jsonl'),
      `${JSON.stringify(withLegacy)}\n${JSON.stringify(withNew)}\n`,
      'utf8'
    );

    const entries = readEntries(cache).entries;
    expect(entries[0].buildUrl).toBe('https://ci.example/old');
    expect(entries[1].buildUrl).toBe('https://ci.example/new');
    expect(JSON.parse(readFileSync(path.join(cache, 'journal.jsonl'), 'utf8').split('\n')[0])).toEqual(
      expect.objectContaining({ jenkinsUrl: 'https://ci.example/old' })
    );
    expect(JSON.parse(readFileSync(path.join(cache, 'journal.jsonl'), 'utf8').split('\n')[0])).not.toHaveProperty(
      'buildUrl'
    );
  });

  it('сохраняет метку старой версии подписи при чтении', () => {
    writeFileSync(
      path.join(cache, 'journal.jsonl'),
      `${JSON.stringify(entry({ signatureVersion: 'legacy' }))}\n`,
      'utf8'
    );

    expect(readEntries(cache).entries[0].signatureVersion).toBe('legacy');
  });
});

describe('Подсчёт повторов ошибки', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-07T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('считает повторы одного отпечатка', () => {
    appendEntry(cache, entry());
    appendEntry(cache, entry({ build: 31 }));
    const result = countFingerprint(cache, exactSignature, 30);
    expect(result.count).toBe(2);
  });

  it('перечисляет прогоны, где отпечаток встречался', () => {
    appendEntry(cache, entry());
    const result = countFingerprint(cache, exactSignature, 30);
    expect(result.builds).toEqual(['backend/all-tests#30']);
  });

  it('не учитывает записи старше заданного срока', () => {
    const now = Date.parse('2026-09-19T12:00:00.000Z');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const edge = now - 30 * 24 * 60 * 60 * 1000;
      appendEntry(cache, entry({ build: 1, analyzedAt: new Date(edge - 1).toISOString() }));
      appendEntry(cache, entry({ build: 2, analyzedAt: new Date(edge).toISOString() }));
      appendEntry(cache, entry({ build: 3, analyzedAt: new Date(edge + 1).toISOString() }));
      expect(countFingerprint(cache, exactSignature, 30)).toEqual({
        count: 2, builds: ['backend/all-tests#2', 'backend/all-tests#3']
      });
    } finally {
      clock.mockRestore();
    }
  });

  it('возвращает ноль для незнакомого отпечатка', () => {
    appendEntry(cache, entry());
    expect(countFingerprint(cache, 'другая ошибка', 30).count).toBe(0);
  });
});


describe('Атомарное дозаполнение журнала', () => {
  function journalEntry(overrides: Partial<JournalEntryInput> = {}): JournalEntryInput {
    return {
      job: 'backend/all-tests',
      build: 30,
      analyzedAt: '2026-08-06T03:12:00.000Z',
      env: 'stage',
      city: 'spb',
      branch: '',
      codeBranch: 'main',
      result: 'FAILURE',
      testsRan: true,
      total: 1,
      failed: 1,
      recoveredAfterRetry: 0,
      verdict: 'проверка',
      fingerprints: [],
      model: 'test',
      analysisDurationMs: 1,
      buildTimestamp: null,
      durationMs: null,
      commit: null,
      buildUrl: null,
      tokensIn: 0,
      tokensOut: 0,
      ...overrides
    };
  }

  let cacheDir: string;
  beforeEach(() => { cacheDir = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-cache-')); });
  afterEach(() => { rmSync(cacheDir, { recursive: true, force: true }); });

  it('appendMissingEntries пишет через временный файл и переименование', () => {
      writeFileSync(path.join(cacheDir, 'journal.jsonl'), 'не JSON\n', 'utf8');
      const added = appendMissingEntries(cacheDir, [journalEntry({ build: 40, testsRan: false })]);
      expect(added).toBe(1);
      expect(readdirSync(cacheDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      const text = readFileSync(path.join(cacheDir, 'journal.jsonl'), 'utf8');
      expect(text).toContain('не JSON');
      expect(readEntries(cacheDir).entries).toHaveLength(1);
    });
});
