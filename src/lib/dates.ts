/** Calendar-date helpers on 'YYYY-MM-DD' strings. No time zones involved: leave and attendance days are plain dates. */
export type ISODate = string;

export const toISO = (d: Date): ISODate =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
export const fromISO = (s: ISODate) => new Date(`${s}T00:00:00Z`);
export const addDaysISO = (s: ISODate, n: number) => { const d = fromISO(s); d.setUTCDate(d.getUTCDate() + n); return toISO(d); };
export function eachDay(from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let d = from; d <= to; d = addDaysISO(d, 1)) out.push(d);
  return out;
}
export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export const weekday = (s: ISODate) => WEEKDAYS[fromISO(s).getUTCDay()];
/** 1..5: which occurrence of this weekday in its month (e.g. 2nd Saturday). */
export const weekOfMonth = (s: ISODate) => Math.ceil(fromISO(s).getUTCDate() / 7);

/** Today's calendar date in a time zone (default IST). Server-side only (reads the clock). */
export function todayIn(tz = "Asia/Kolkata", now = new Date()): ISODate {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
