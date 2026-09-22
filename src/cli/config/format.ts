import type { ConfigFieldDescription } from '../../configDescribe.js';

export function formatField(field: ConfigFieldDescription): string {
  if (field.set !== undefined) {
    return field.set ? 'задан' : 'не задан';
  }
  if (Array.isArray(field.value)) {
    return field.value.length > 0 ? field.value.join(', ') : '(пусто)';
  }
  if (field.value !== undefined && typeof field.value === 'object') {
    return JSON.stringify(field.value);
  }
  return field.value === undefined || field.value === '' ? '(не задано)' : String(field.value);
}

export function printFieldLine(label: string, field: ConfigFieldDescription): void {
  console.log(`${label}: ${formatField(field)} (источник: ${field.source})`);
}
