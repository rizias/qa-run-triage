import { describe, it, expect } from 'vitest';
import {
  toJenkinsPath,
  workspacePath,
  workspaceSourcePath
} from '../../src/jenkins/paths.js';

describe('Путь джобы Jenkins', () => {
  it('разворачивает вложенную джобу в форму Jenkins', () => {
    expect(toJenkinsPath('backend/smoke')).toBe('job/backend/job/smoke');
  });

  it('обрабатывает джобу верхнего уровня', () => {
    expect(toJenkinsPath('TA_Android_smoke')).toBe('job/TA_Android_smoke');
  });

  it('терпит лишние слэши по краям', () => {
    expect(toJenkinsPath('/backend/all-tests/')).toBe('job/backend/job/all-tests');
  });

  it('отвергает пустое имя', () => {
    expect(() => toJenkinsPath('')).toThrow('Пустой путь джобы');
  });
});

describe('Пути рабочего каталога', () => {
  it('строит путь рабочего каталога и архива с прямыми слэшами', () => {
    expect(workspacePath('backend/all-tests', 81, 18)).toBe(
      'job/backend/job/all-tests/81/execution/node/18/ws/'
    );
    expect(workspaceSourcePath('backend/all-tests', 81, 18)).toBe(
      'job/backend/job/all-tests/81/execution/node/18/ws/src/*zip*/src.zip'
    );
  });
});
