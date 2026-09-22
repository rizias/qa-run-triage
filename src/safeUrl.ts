export function maskUrlUserinfo(text: string): string {
  return text.replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/]*@/gi, '$1***@');
}

export function assertBaseUrl(value: string, field: string): void {
  if (!value) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field}: требуется корректный URL без учётных данных.`);
  }
  if (url.username || url.password || maskUrlUserinfo(value) !== value) {
    throw new Error(`${field}: URL не должен содержать учётные данные.`);
  }
}

export function safeError(error: unknown, seen = new Set<unknown>()): Error {
  if (!(error instanceof Error)) return new Error(maskUrlUserinfo(String(error)));
  const result = new Error(maskUrlUserinfo(error.message));
  result.name = error.name;
  seen.add(error);
  if (error.cause !== undefined && !seen.has(error.cause)) result.cause = safeError(error.cause, seen);
  return result;
}
