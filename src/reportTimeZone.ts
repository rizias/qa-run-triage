export function assertReportTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone });
  } catch {
    throw new Error('Поле report.timeZone должно содержать допустимый часовой пояс IANA (QA_RUN_TRIAGE_REPORT_TIME_ZONE).');
  }
}

export function reportUtcOffset(timeZone: string, date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(date);
  const offset = parts.find((part) => part.type === 'timeZoneName')!.value.replace('GMT', 'UTC');
  return offset === 'UTC+0' ? 'UTC' : offset;
}
