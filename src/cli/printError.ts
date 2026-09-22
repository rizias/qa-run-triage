function errorText(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

export function printCliError(error: unknown): void {
  const seen = new Set<unknown>();
  let current: unknown = error;
  let prefix = '';
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    console.error(maskUrlUserinfo(`${prefix}${errorText(current)}`));
    prefix = 'Причина: ';
    current = current instanceof Error ? current.cause : undefined;
  }
}
import { maskUrlUserinfo } from '../safeUrl.js';
