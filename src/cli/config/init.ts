import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import path from 'node:path';
import { resolveProfileSelection } from '../../commonConfig.js';
import {
  buildDefaultCommonContents,
  buildDefaultCredentialsContents,
  buildDefaultProfileContents,
  commonFilePath
} from '../../configFields.js';

export function runConfigInit(
  env: NodeJS.ProcessEnv,
  explicitConfigFile: string | undefined,
  explicitProfile: string | undefined
): void {
  if (explicitConfigFile) {
    throw new Error(
      'Для config init не используется флаг --config: команда работает только с профилями. ' +
        'Используйте config init или config init --profile <имя>.'
    );
  }
  const commonPath = commonFilePath();
  createExclusive(
    commonPath,
    buildDefaultCommonContents(),
    `Общий файл создан: ${commonPath}`,
    `Общий файл уже существует: ${commonPath}`
  );

  const selection = resolveProfileSelection(env, undefined, explicitProfile);
  createExclusive(
    selection.profileFile,
    buildDefaultProfileContents(),
    `Файл профиля создан: ${selection.profileFile}`,
    `Файл профиля уже существует: ${selection.profileFile}`
  );
  createExclusive(
    selection.credentialsFile,
    buildDefaultCredentialsContents(),
    `Файл секретов создан: ${selection.credentialsFile}`,
    `Файл секретов уже существует: ${selection.credentialsFile}`
  );
}

function createExclusive(
  file: string,
  contents: Record<string, unknown>,
  createdMessage: string,
  existsMessage: string
): void {
  mkdirSync(path.dirname(file), { recursive: true });
  let fd: number;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      console.log(existsMessage);
      return;
    }
    throw error;
  }
  try {
    writeSync(fd, `${JSON.stringify(contents, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
  console.log(createdMessage);
}
