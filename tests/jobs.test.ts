import { describe, expect, it } from 'vitest';
import { resolveJobSettings, validateJobs } from '../src/jobs.js';
import { resolveServerNameForJob } from '../src/serverResolution.js';

describe('Выбор настроек джобы', () => {
  it('полное имя джобы важнее папки', () => {
    const jobs = {
      Playwright: { server: 'folder' },
      'Playwright/e2e': { server: 'exact' }
    };

    expect(resolveJobSettings('Playwright/e2e', jobs).server).toBe('exact');
  });

  it('папка покрывает джобы внутри', () => {
    const jobs = { Playwright: { server: 'ui' } };

    expect(resolveJobSettings('Playwright/e2e', jobs).server).toBe('ui');
  });

  it('ни одна группа не совпадает — сервер не задан, поле называет defaultServer', () => {
    const jobs = { Playwright: { server: 'ui' } };

    const settings = resolveJobSettings('backend/smoke', jobs);

    expect(settings.server).toBeUndefined();
    expect(settings.serverField).toBe('defaultServer');
  });

  it('блок jobs отсутствует вовсе — сервер не задан', () => {
    const settings = resolveJobSettings('backend/smoke', undefined);

    expect(settings).toEqual({ server: undefined, serverField: 'defaultServer' });
  });

  it('server самой длинной совпавшей группы', () => {
    const jobs = { Playwright: { server: 'ui' } };

    const settings = resolveJobSettings('Playwright/e2e', jobs);

    expect(settings.server).toBe('ui');
    expect(settings.serverField).toBe('jobs.Playwright.server');
  });
});

describe('ошибка разрешения сервера', () => {
  it('Ошибка разрешения сервера называет serverField', () => {
    expect(() =>
      resolveServerNameForJob({ Playwright: {} }, undefined, ['main', 'ui'], 'Playwright/e2e')
    ).toThrow(/jobs\.Playwright\.server/);
    expect(() => resolveServerNameForJob(undefined, undefined, ['main', 'ui'], 'backend/smoke')).toThrow(
      /defaultServer/
    );
  });
});


describe('Проверка групп джоб', () => {
  it('Ключ звёздочка в jobs и группа без server — ошибка с именем поля', () => {
      expect(() => validateJobs({ '*': { server: 'main' } }, '/profile.json')).toThrow(/jobs\.\*/);
      expect(() => validateJobs({ Playwright: {} }, '/profile.json')).toThrow(/jobs\.Playwright\.server/);
    });

  it('Ключи jobs сравниваются без учёта регистра как allowedJobs', () => {
      const jobs = { Playwright: { server: 'ui' } };
      expect(resolveJobSettings('playwright/e2e', jobs).server).toBe('ui');
      expect(resolveJobSettings('/Playwright/', jobs).server).toBe('ui');
    });
});
