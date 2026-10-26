/** Dates and times as they are read and typed in Switzerland (Europe/Zurich). */

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Zurich',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** The Swiss calendar date ("2026-10-27") and clock time ("07:30") of an instant. */
export function zurichMoment(ms: number): { date: string; time: string } {
  const p: Record<string, string> = {};
  for (const part of PARTS.formatToParts(new Date(ms))) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** "07:34" (Swiss time) of a Unix time in seconds. */
export function formatClock(seconds: number): string {
  return zurichMoment(seconds * 1000).time;
}

/** "7:30", "07:30", "7.30", "7h30", "730", "7" -> "07:30"; null when it is not a time. */
export function parseClock(text: string): string | null {
  const match = /^\s*(\d{1,2})(?:\s*[:.hH]\s*(\d{2})|(\d{2}))?\s*$/.exec(text);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? match[3] ?? 0);
  if (hours > 23 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/** Weekday names in English and the national languages, Sunday first. */
const WEEKDAYS: string[][] = [
  ['sunday', 'sun', 'sonntag', 'so', 'dimanche', 'dim', 'domenica', 'dom'],
  ['monday', 'mon', 'montag', 'mo', 'lundi', 'lun', 'lunedi', 'lunedì'],
  ['tuesday', 'tue', 'dienstag', 'di', 'mardi', 'mar', 'martedi', 'martedì'],
  ['wednesday', 'wed', 'mittwoch', 'mi', 'mercredi', 'mer', 'mercoledi', 'mercoledì'],
  ['thursday', 'thu', 'donnerstag', 'do', 'jeudi', 'jeu', 'giovedi', 'giovedì'],
  ['friday', 'fri', 'freitag', 'fr', 'vendredi', 'ven', 'venerdi', 'venerdì'],
  ['saturday', 'sat', 'samstag', 'sa', 'samedi', 'sam', 'sabato', 'sab'],
];

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function isRealDate(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * "today", "tomorrow", "2026-10-27", "27.10.", "27.10.2026" or a weekday ("friday",
 * "freitag", "vendredi": the next one, today included) -> "2026-10-27"; null otherwise.
 */
export function parseDay(text: string, now: number = Date.now()): string | null {
  const today = zurichMoment(now).date;
  const value = text.trim().toLowerCase();
  if (['today', 'heute', "aujourd'hui", 'oggi'].includes(value)) return today;
  if (['tomorrow', 'morgen', 'demain', 'domani'].includes(value)) return addDays(today, 1);
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  const swiss = /^(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})?$/.exec(value);
  if (iso || swiss) {
    const [y, m, d] = iso
      ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
      : [
          swiss?.[3]
            ? Number(swiss[3].length === 2 ? `20${swiss[3]}` : swiss[3])
            : Number(today.slice(0, 4)),
          Number(swiss?.[2]),
          Number(swiss?.[1]),
        ];
    if (!isRealDate(y, m, d)) return null;
    const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    // "3.1." in December means next January.
    return !iso && !swiss?.[3] && date < today ? `${y + 1}${date.slice(4)}` : date;
  }
  const weekday = WEEKDAYS.findIndex((names) => names.includes(value));
  if (weekday < 0) return null;
  const current = new Date(`${today}T12:00:00Z`).getUTCDay();
  return addDays(today, (weekday - current + 7) % 7);
}

/** "2026-10-27" -> "Tuesday 27 October 2026". */
export function formatDayLong(date: string): string {
  const day = new Date(`${date}T12:00:00Z`);
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(day);
  return `${part({ weekday: 'long' })} ${day.getUTCDate()} ${part({ month: 'long' })} ${day.getUTCFullYear()}`;
}

/** Minutes as "2h 22m" or "45 min". */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}
