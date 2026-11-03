/**
 * The in-app scheduler's decision, pure: given the clock, the configured time of day and what ran before, should the
 * daily run start now? Runs once a day at or after `time` (in `tz`), catching up if the runner starts later in the day,
 * and optionally repeats every `repeatMinutes` after that (escalations and queued email stay timely; once-a-day steps skip themselves).
 */
import { todayIn, type ISODate } from "@/lib/dates";

export type SchedulerState = { lastRunDate: ISODate | null; lastRunAt: number | null };
export type SchedulerConfig = { time: string; tz: string; repeatMinutes: number };

export function parseTime(s: string | undefined, fallback = "00:15"): string {
  const m = (s ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return fallback;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

/** "HH:MM" local time in tz for an instant. */
export function clockIn(tz: string, now: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("hour")}:${g("minute")}`;
}

export function shouldRun(c: SchedulerConfig, s: SchedulerState, now: Date): { run: boolean; why: string; date: ISODate } {
  const date = todayIn(c.tz, now);
  const hhmm = clockIn(c.tz, now);
  if (hhmm < c.time) return { run: false, why: `waiting for ${c.time}`, date };
  if (s.lastRunDate !== date) return { run: true, why: s.lastRunDate ? `first run of ${date}` : "first run since start", date };
  if (c.repeatMinutes > 0 && s.lastRunAt != null && now.getTime() - s.lastRunAt >= c.repeatMinutes * 60_000) return { run: true, why: `repeat every ${c.repeatMinutes} min`, date };
  return { run: false, why: "already ran today", date };
}
