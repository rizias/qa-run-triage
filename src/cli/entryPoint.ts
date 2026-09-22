import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function isEntryPoint(moduleUrl: string, launchedFile: string | undefined): boolean {
  if (launchedFile === undefined) {
    return false;
  }
  return canonical(path.resolve(launchedFile)) === canonical(fileURLToPath(moduleUrl));
}

function canonical(file: string): string {
  try {
    return realpathSync.native(file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Не удалось разрешить путь ${file}: ${message}`);
    return file;
  }
}
