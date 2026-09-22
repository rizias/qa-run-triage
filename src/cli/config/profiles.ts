import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { resolveProfileSelection } from '../../commonConfig.js';
import { homeStateDir, profileJsonPath } from '../../configFields.js';
import { validateProfileFile } from '../../configValidation.js';
import { parseJsonSafely } from '../../secretJson.js';

export function runConfigProfiles(
  env: NodeJS.ProcessEnv,
  explicitConfigFile: string | undefined,
  explicitProfile: string | undefined
): void {
  const selected = resolveProfileSelection(env, explicitConfigFile, explicitProfile);
  const profilesDir = path.join(homeStateDir(), 'profiles');
  const names = existsSync(profilesDir)
    ? readdirSync(profilesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== 'default')
        .map((entry) => entry.name)
        .filter((name) => existsSync(profileJsonPath(name)))
        .sort()
    : [];

  for (const name of ['default', ...names]) {
    console.log(formatRow(name, readDescription(name), selected));
  }
}

function formatRow(
  name: string,
  description: string,
  selected: ReturnType<typeof resolveProfileSelection>
): string {
  const suffix = description ? ` — ${description}` : '';
  if (!selected.explicitFile && selected.profileName === name) {
    return `${name}${suffix} (выбран: ${selected.source})`;
  }
  return `${name}${suffix}`;
}

function readDescription(name: string): string {
  const file = profileJsonPath(name);
  if (!existsSync(file)) {
    return '';
  }
  try {
    const parsed = validateProfileFile(parseJsonSafely(file, readFileSync(file, 'utf8'), 'профиля'), file);
    return parsed.description ?? '';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    const message = error instanceof Error ? error.message : String(error);
    return `(не прочитано: ${message})`;
  }
}
