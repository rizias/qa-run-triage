import { describe, expect, it } from 'vitest';
import { environmentFrom } from '../../src/journal/environment.js';

describe('Окружение билда', () => {
  it('берёт значение параметра с настроенным именем', () => {
    const result = environmentFrom(
      { STAND: 'stage-2' },
      { env: ['env', 'STAND'], city: ['city'] }
    );
    expect(result.env).toBe('stage-2');
  });

  it('приоритет — первое из перечисленных имён, которое есть у билда', () => {
    const result = environmentFrom(
      { env: 'stage', STAND: 'stage-2' },
      { env: ['env', 'STAND'], city: ['city'] }
    );
    expect(result.env).toBe('stage');
  });

  it('измерение пустое, когда ни одного параметра нет', () => {
    const result = environmentFrom({ sendToTestOps: 'true' }, { env: ['env'], city: ['city'] });
    expect(result).toEqual({ env: '', city: '' });
  });

  it('отсутствие параметров вовсе — измерения пустые', () => {
    const result = environmentFrom(undefined, { env: ['env'], city: ['city'] });
    expect(result).toEqual({ env: '', city: '' });
  });
});
