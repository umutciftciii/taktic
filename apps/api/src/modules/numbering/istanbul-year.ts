const ISTANBUL_YEAR_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Istanbul',
  year: 'numeric',
});

export function getIstanbulYear(date: Date): number {
  return Number.parseInt(ISTANBUL_YEAR_FORMATTER.format(date), 10);
}
