/** Attendance status labels, short codes and colours. Plain module so server pages and client components can share it. */
export type Tone = "success" | "warning" | "danger" | "neutral" | "accent";

export const DAY_STATUS: Record<string, { label: string; code: string; tone: Tone }> = {
  present: { label: "Present", code: "P", tone: "success" },
  absent: { label: "Absent", code: "A", tone: "danger" },
  leave: { label: "On leave", code: "L", tone: "accent" },
  half_leave: { label: "Half-day leave", code: "½L", tone: "accent" },
  half_day: { label: "Half day", code: "½", tone: "warning" },
  wfh: { label: "Work from home", code: "W", tone: "success" },
  on_duty: { label: "On duty", code: "OD", tone: "success" },
  weekly_off: { label: "Weekly off", code: "WO", tone: "neutral" },
  half_weekly_off: { label: "Half weekly off", code: "½WO", tone: "neutral" },
  holiday: { label: "Holiday", code: "H", tone: "neutral" },
  today: { label: "Today", code: "•", tone: "accent" },
  upcoming: { label: "Upcoming", code: "", tone: "neutral" },
  not_joined: { label: "Not with us yet", code: "–", tone: "neutral" },
};
export const statusOf = (s: string) => DAY_STATUS[s] ?? { label: s, code: "?", tone: "neutral" as Tone };

/** Cell backgrounds for the team grid, by tone (role tokens only). */
export const TONE_CELL: Record<Tone, string> = {
  success: "bg-success-soft text-success-text",
  warning: "bg-warning-soft text-warning-text",
  danger: "bg-danger-soft text-danger-text",
  accent: "bg-accent-soft text-accent-text",
  neutral: "bg-neutral-soft text-neutral-text",
};

export const REQUEST_KIND: Record<string, string> = { regularization: "Regularize", partial_day: "Partial day", wfh: "Work from home", on_duty: "On duty" };
export const PENALTY_RULE: Record<string, string> = { late_arrival: "Late arrival", hours_shortage: "Short hours", no_attendance: "No attendance", missing_swipe: "Missing swipe" };

export const hm = (m: number) => (m ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : "—");
export const clock = (iso: string | null, tz = "Asia/Kolkata") => (iso ? new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: tz }) : "—");
export const dayLabel = (d: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short" }) =>
  new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { ...opts, timeZone: "UTC" });
