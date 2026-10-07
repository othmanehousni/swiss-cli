/** Formatting for humans: money, sizes, dates, durations. */

export function formatChf(value: number | null | undefined): string {
  return value == null ? '–' : `CHF ${value.toFixed(2)}`;
}

const BASIS_LABEL: Record<string, string> = { kg: 'kg', l: 'l', piece: 'pc' };

export function formatUnitPrice(
  value: number | null | undefined,
  basis: string | null | undefined,
): string {
  if (value == null || !basis) return '–';
  return `CHF ${value.toFixed(value < 0.1 ? 4 : 2)}/${BASIS_LABEL[basis] ?? basis}`;
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

export function formatPercent(part: number, total: number): string {
  if (total === 0) return '–';
  return `${Math.round((part / total) * 100)}%`;
}

const ZURICH_DATE = new Intl.DateTimeFormat('de-CH', {
  timeZone: 'Europe/Zurich',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const ZURICH_DAY = new Intl.DateTimeFormat('de-CH', {
  timeZone: 'Europe/Zurich',
  day: '2-digit',
  month: '2-digit',
});
const ZURICH_DATE_TIME = new Intl.DateTimeFormat('de-CH', {
  timeZone: 'Europe/Zurich',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** Swiss date, e.g. "07.10.2026". */
export function formatDate(iso: string | null | undefined): string {
  return iso ? ZURICH_DATE.format(new Date(iso)) : '–';
}

/** Short Swiss date without the year, e.g. "07.10.". */
export function formatDay(iso: string | null | undefined): string {
  return iso ? `${ZURICH_DAY.format(new Date(iso))}` : '–';
}

export function formatDateTime(iso: string | null | undefined): string {
  return iso ? ZURICH_DATE_TIME.format(new Date(iso)) : '–';
}

/** "just now", "5 minutes ago", "3 days ago". */
export function formatAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never';
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  const units: [number, string][] = [
    [86_400, 'day'],
    [3_600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, name] of units) {
    if (seconds >= size) {
      const n = Math.floor(seconds / size);
      return `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Describes an offer: "-20% until 12.10.", "from 12.10.", "Lidl Plus CHF 1.59". */
export function formatOffer(
  row: {
    promo_label: string | null;
    regular_price: number | null;
    loyalty_price: number | null;
    valid_from: string | null;
    valid_until: string | null;
  },
  now: number = Date.now(),
): string {
  const parts: string[] = [];
  if (row.promo_label) parts.push(row.promo_label);
  if (row.loyalty_price != null) parts.push(`app ${formatChf(row.loyalty_price)}`);
  else if (row.regular_price != null) parts.push(`was ${formatChf(row.regular_price)}`);
  if (row.valid_from && Date.parse(row.valid_from) > now)
    parts.push(`from ${formatDay(row.valid_from)}`);
  else if (row.valid_until) parts.push(`until ${formatDay(row.valid_until)}`);
  return parts.join(' · ');
}
