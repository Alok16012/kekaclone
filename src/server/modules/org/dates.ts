import type { ISODate } from "@/lib/dates";

/** Next occurrence of a yearly date (birthday / work anniversary) on or after `from`; Feb 29 falls on Feb 28 outside leap years. */
export function nextOccurrence(md: string /* MM-DD */, from: ISODate): ISODate {
  const y = Number(from.slice(0, 4));
  const leap = (yy: number) => yy % 4 === 0 && (yy % 100 !== 0 || yy % 400 === 0);
  const fix = (yy: number) => (md === "02-29" && !leap(yy) ? "02-28" : md);
  const thisYear = `${y}-${fix(y)}`;
  return thisYear >= from ? thisYear : `${y + 1}-${fix(y + 1)}`;
}
