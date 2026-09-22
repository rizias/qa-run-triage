import { cpSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installSkills, maybeRefreshSkills } from '../../src/skills/updater.js';
import { type Ask, readRegistry } from '../../src/skills/updaterState.js';
import { templatesDir } from '../../src/skills/setup.js';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

let state: string;
let target: string;

const askInto = (root: string, approve = true): Ask => ({
  chooseTargets: () => Promise.resolve([{ id: 'custom', root }]),
  confirm: () => Promise.resolve(approve)
});

beforeEach(() => {
  state = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-state-'));
  target = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-target-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(state, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

describe('установка и обновление скиллов', () => {
  it('ставит скилл в выбранный путь и записывает реестр рядом с настройками', async () => {
    const report = await installSkills({
      pkgName: '@rizias/qa-run-triage',
      version: '0.0.0',
      templates: templatesDir(),
      stateDir: state,
      ask: askInto(target)
    });

    expect(report.skills).toEqual(['qa-run-triage']);
    expect(report.installed).toHaveLength(1);
    const installedDir = report.installed[0];
    expect(readFileSync(path.join(installedDir, 'SKILL.md'), 'utf8'))
      .toBe(readFileSync(path.join(templatesDir(), 'qa-run-triage', 'SKILL.md'), 'utf8'));
    const registry = JSON.parse(readFileSync(path.join(state, 'skills-registry.json'), 'utf8')) as
      Record<string, { skills: Record<string, { path: string }[]> }>;
    expect(registry['@rizias/qa-run-triage'].skills['qa-run-triage'][0].path).toBe(installedDir);
  });

  it('без подтверждения не пишет ничего', async () => {
    const report = await installSkills({
      pkgName: '@rizias/qa-run-triage',
      version: '0.0.0',
      templates: templatesDir(),
      stateDir: state,
      ask: askInto(target, false)
    });

    expect(report.installed).toHaveLength(0);
    expect(existsSync(path.join(target, '.claude'))).toBe(false);
    expect(existsSync(path.join(state, 'skills-registry.json'))).toBe(false);
  });

  it('удаляет из реестра запись о копии с исчезнувшим каталогом и называет путь в отчёте', async () => {
    const missing = path.join(target, 'gone', 'qa-run-triage');
    writeFileSync(
      path.join(state, 'skills-registry.json'),
      JSON.stringify({
        '@rizias/qa-run-triage': {
          version: '0.0.0',
          skills: {
            'qa-run-triage': [{ path: missing, files: ['SKILL.md'] }]
          }
        }
      }),
      'utf8'
    );

    const report = await installSkills({
      pkgName: '@rizias/qa-run-triage',
      version: '0.0.0',
      templates: templatesDir(),
      stateDir: state,
      ask: askInto(target)
    });

    expect(report.pruned).toEqual([missing]);
    const registry = JSON.parse(readFileSync(path.join(state, 'skills-registry.json'), 'utf8')) as
      Record<string, { skills: Record<string, { path: string }[]> }>;
    expect(registry['@rizias/qa-run-triage'].skills['qa-run-triage'].map((copy) => copy.path))
      .not.toContain(missing);
  });

  it('Сбой обновления скилла не молчит', () => {
    writeFileSync(path.join(state, 'skills-registry.json'), '{не json', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const report = maybeRefreshSkills({
      pkgName: '@rizias/qa-run-triage',
      version: '0.0.0',
      templates: templatesDir(),
      stateDir: state
    });
    expect(warn.mock.calls.some((call) => String(call[0]).includes('Не удалось прочитать'))).toBe(
      true
    );
    expect(report.refreshed).toEqual([]);
  });

  it('пишет отметку недоступного пути в реестр и молчит о нём до следующего дня', () => {
    const unavailable = path.join(target, 'missing', '.claude', 'skills', 'qa-run-triage');
    writeFileSync(
      path.join(state, 'skills-registry.json'),
      JSON.stringify({
        '@rizias/qa-run-triage': {
          version: '0.0.0',
          skills: {
            'qa-run-triage': [{ path: unavailable, files: ['SKILL.md'] }]
          }
        }
      }),
      'utf8'
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    maybeRefreshSkills({
      pkgName: '@rizias/qa-run-triage',
      version: '0.0.0',
      templates: templatesDir(),
      stateDir: state
    });

    expect(stderr.mock.calls.map(([message]) => String(message)).join('')).toContain('путь недоступен');
    const registry = JSON.parse(readFileSync(path.join(state, 'skills-registry.json'), 'utf8')) as
      Record<string, { unavailable?: Record<string, number> }>;
    expect(registry['@rizias/qa-run-triage'].unavailable?.[unavailable]).toEqual(expect.any(Number));
    expect(existsSync(path.join(state, 'update-check.json'))).toBe(false);

    stderr.mockClear();
    maybeRefreshSkills({
      pkgName: '@rizias/qa-run-triage',
      version: '0.0.0',
      templates: templatesDir(),
      stateDir: state
    });

    expect(stderr.mock.calls.map(([message]) => String(message)).join('')).not.toContain('путь недоступен');
  });

  it('обновляет копию при смене версии в пакете и не трогает чужой файл рядом', async () => {
    const templates = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-templates-'));
    const skillDir = path.join(templates, 'qa-run-triage');
    cpSync(path.join(templatesDir(), 'qa-run-triage'), skillDir, { recursive: true });
    const first = await installSkills({
      pkgName: '@rizias/qa-run-triage',
      version: '0.0.0',
      templates,
      stateDir: state,
      ask: askInto(target)
    });
    const installedDir = first.installed[0];
    const foreign = path.join(installedDir, 'заметки-пользователя.md');
    writeFileSync(foreign, 'моё', 'utf8');
    const doc = path.join(skillDir, 'SKILL.md');
    writeFileSync(
      doc,
      readFileSync(doc, 'utf8').replace(/qa-run-triage-skill-version: \S+/, 'qa-run-triage-skill-version: 9.9.9'),
      'utf8'
    );

    const report = maybeRefreshSkills({
      pkgName: '@rizias/qa-run-triage',
      version: '0.1.0',
      templates,
      stateDir: state,
      quiet: true
    });

    expect(report.refreshed).toHaveLength(1);
    expect(readFileSync(path.join(installedDir, 'SKILL.md'), 'utf8'))
      .toBe(readFileSync(doc, 'utf8'));
    expect(readFileSync(foreign, 'utf8')).toBe('моё');
    rmSync(templates, { recursive: true, force: true });
  });

  it('актуальную копию не переписывает', async () => {
    await installSkills({
      pkgName: '@rizias/qa-run-triage',
      version: '0.0.0',
      templates: templatesDir(),
      stateDir: state,
      ask: askInto(target)
    });

    const report = maybeRefreshSkills({
      pkgName: '@rizias/qa-run-triage',
      version: '0.0.0',
      templates: templatesDir(),
      stateDir: state,
      quiet: true
    });

    expect(report.refreshed).toHaveLength(0);
  });
});


describe('Сохранность реестра скиллов', () => {
  it('Битый JSON реестра не подменяется пустым файлом', () => {
      const state = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-rf4-reg-'));
      const file = path.join(state, 'skills-registry.json');
      writeFileSync(file, 'не JSON', 'utf8');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        maybeRefreshSkills({
          pkgName: '@rizias/qa-run-triage',
          version: '0.0.0',
          templates: templatesDir(),
          stateDir: state,
          quiet: true
        });
        expect(readFileSync(file, 'utf8')).toBe('не JSON');
        expect(warn.mock.calls.join(' ')).toMatch(/skills-registry\.json/);
      } finally {
        warn.mockRestore();
        rmSync(state, { recursive: true, force: true });
      }
    });

  it('Два процесса не затирают реестр', async () => {
      const state = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-rf4-reg2-'));
      const worker = path.join(state, 'worker.mjs');
      const moduleUrl = pathToFileURL(path.resolve('dist/skills/updaterState.js')).href;
      writeFileSync(worker, `
        import { mutateRegistry } from ${JSON.stringify(moduleUrl)};
        process.send('ready');
        process.on('message', () => {
          mutateRegistry(process.argv[2], (registry) => {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
            registry[process.argv[3]] = { version: '1', skills: {} };
          });
          process.exit(0);
        });
      `);
      const children = ['a', 'b'].map((name) => fork(worker, [state, name], { silent: true }));
      try {
        await Promise.all(children.map((child) => once(child, 'message')));
        const exits = children.map((child) => once(child, 'exit'));
        children.forEach((child) => child.send('start'));
        expect(await Promise.all(exits)).toEqual([[0, null], [0, null]]);
        const saved = readRegistry(state);
        expect(Object.keys(saved).sort()).toEqual(['a', 'b']);
      } finally {
        children.forEach((child) => { if (child.exitCode === null) child.kill(); });
        rmSync(state, { recursive: true, force: true });
      }
    });
});


describe('Границы путей реестра', () => {
  let cache: string;

  beforeEach(() => { cache = mkdtempSync(path.join(tmpdir(), 'qa-run-triage-cache-')); });
  afterEach(() => { vi.restoreAllMocks(); rmSync(cache, { recursive: true, force: true }); });

  it.each(['file', 'destination'])('реестр пропускает выход через %s до записи и удаления', (kind) => {
    const dest = path.join(cache, '.claude', 'skills', 'qa-run-triage');
    mkdirSync(dest, { recursive: true });
    const outside = path.join(cache, '.claude', 'outside.txt');
    writeFileSync(outside, 'сохранить');
    writeFileSync(path.join(dest, 'SKILL.md'), 'сохранить скилл');
    const copyPath = kind === 'file' ? dest : path.join(cache, '.claude');
    writeFileSync(path.join(cache, 'skills-registry.json'), JSON.stringify({
      example: { version: 'old', skills: { 'qa-run-triage': [{
        path: copyPath, files: kind === 'file' ? ['..\\..\\outside.txt'] : ['outside.txt']
      }] } }
    }));
    const report = maybeRefreshSkills({ pkgName: 'example', version: 'new', templates: templatesDir(), stateDir: cache });
    expect(report.refreshed).toEqual([]);
    expect(report.skipped[0].message).toMatch(/путь|Путь/);
    expect(readFileSync(outside, 'utf8')).toBe('сохранить');
    expect(readFileSync(path.join(dest, 'SKILL.md'), 'utf8')).toBe('сохранить скилл');
    expect(existsOutsideSkill()).toBe(false);
    function existsOutsideSkill(): boolean {
      return readdirSync(path.join(cache, '.claude')).includes('SKILL.md');
    }
  });
});
