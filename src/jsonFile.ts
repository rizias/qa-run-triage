export function parseJsonText(file: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Файл ${file} не разбирается как JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}
