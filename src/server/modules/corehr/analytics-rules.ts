/** People analytics: headcount, attrition and tenure arithmetic over plain employment records. Pure (no I/O). */
import { fromISO, type ISODate } from "@/lib/dates";

export type EmploymentRecord = { id: string; joining_date: ISODate; exit_date: ISODate | null; department: string | null; reason: string | null; kind: "resignation" | "company_action" | null };

export const monthKey = (d: ISODate) => d.slice(0, 7);
export const monthStart = (ym: string): ISODate => `${ym}-01`;
export function addMonths(ym: string, n: number) {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
/** The months from `from` to `to` inclusive (YYYY-MM). */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = from; m <= to && out.length < 120; m = addMonths(m, 1)) out.push(m);
  return out;
}
export const monthLabel = (ym: string) => new Date(ym + "-01T00:00:00Z").toLocaleDateString("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" });

/** People employed on a date: joined on or before it and not yet left (exit_date on or after it counts as still here that day). */
export const employedOn = (p: EmploymentRecord, date: ISODate) => p.joining_date <= date && (p.exit_date === null || p.exit_date >= date);
/** Left during the month (exit date inside it). */
const leftIn = (p: EmploymentRecord, ym: string) => p.exit_date !== null && monthKey(p.exit_date) === ym;
const joinedIn = (p: EmploymentRecord, ym: string) => monthKey(p.joining_date) === ym;

export type MonthRow = { month: string; label: string; start: number; joined: number; left: number; end: number; rate: number | null };

/** Per month: headcount at the start, joiners, leavers, headcount at the end, attrition = leavers / start (%). */
export function monthlySeries(people: EmploymentRecord[], from: string, to: string): MonthRow[] {
  return monthsBetween(from, to).map((ym) => {
    const startDate = monthStart(ym);
    const start = people.filter((p) => p.joining_date < startDate && (p.exit_date === null || p.exit_date >= startDate)).length;
    const joined = people.filter((p) => joinedIn(p, ym)).length;
    const left = people.filter((p) => leftIn(p, ym)).length;
    return { month: ym, label: monthLabel(ym), start, joined, left, end: start + joined - left, rate: start ? Math.round((left / start) * 1000) / 10 : null };
  });
}

/** Annualised attrition over a window: leavers / average headcount × (12 / months). */
export function annualisedAttrition(rows: MonthRow[]) {
  if (!rows.length) return null;
  const left = rows.reduce((n, r) => n + r.left, 0);
  const avg = rows.reduce((n, r) => n + (r.start + r.end) / 2, 0) / rows.length;
  if (!avg) return null;
  return Math.round((left / avg) * (12 / rows.length) * 1000) / 10;
}

export type GroupRow = { name: string; headcount: number; left: number; rate: number | null };

/** Attrition by department over the window: leavers in the window / headcount at the start of it (people with no department are "No department"). */
export function byDepartment(people: EmploymentRecord[], from: string, to: string): GroupRow[] {
  const startDate = monthStart(from), endDate = monthStart(addMonths(to, 1));
  const groups = new Map<string, { headcount: number; left: number }>();
  for (const p of people) {
    const name = p.department ?? "No department";
    const g = groups.get(name) ?? { headcount: 0, left: 0 };
    if (employedOn(p, startDate) || (p.joining_date >= startDate && p.joining_date < endDate)) g.headcount++;
    if (p.exit_date !== null && p.exit_date >= startDate && p.exit_date < endDate) g.left++;
    groups.set(name, g);
  }
  return [...groups.entries()].map(([name, g]) => ({ name, headcount: g.headcount, left: g.left, rate: g.headcount ? Math.round((g.left / g.headcount) * 1000) / 10 : null }))
    .sort((a, b) => b.left - a.left || b.headcount - a.headcount || a.name.localeCompare(b.name));
}

/** Leavers by recorded reason in the window (exits without a reason are "Not recorded"). */
export function byReason(people: EmploymentRecord[], from: string, to: string): { reason: string; kind: string; n: number }[] {
  const startDate = monthStart(from), endDate = monthStart(addMonths(to, 1));
  const m = new Map<string, { kind: string; n: number }>();
  for (const p of people) {
    if (p.exit_date === null || p.exit_date < startDate || p.exit_date >= endDate) continue;
    const key = p.reason ?? "Not recorded";
    const g = m.get(key) ?? { kind: p.kind === "company_action" ? "Company action" : p.kind === "resignation" ? "Resignation" : "—", n: 0 };
    g.n++; m.set(key, g);
  }
  return [...m.entries()].map(([reason, g]) => ({ reason, kind: g.kind, n: g.n })).sort((a, b) => b.n - a.n || a.reason.localeCompare(b.reason));
}

const daysBetween = (a: ISODate, b: ISODate) => Math.round((fromISO(b).getTime() - fromISO(a).getTime()) / 864e5);

/** Average tenure in years (1 decimal) of the people employed today and of those who left in the window. */
export function averageTenure(people: EmploymentRecord[], today: ISODate, from: string, to: string) {
  const years = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length / 365.25) * 10) / 10 : null);
  const current = people.filter((p) => employedOn(p, today)).map((p) => daysBetween(p.joining_date, today));
  const startDate = monthStart(from), endDate = monthStart(addMonths(to, 1));
  const leavers = people.filter((p) => p.exit_date !== null && p.exit_date >= startDate && p.exit_date < endDate).map((p) => daysBetween(p.joining_date, p.exit_date!));
  return { current: years(current), leavers: years(leavers), currentCount: current.length, leaverCount: leavers.length };
}

/** Tenure bands of the people here today. */
export function tenureBands(people: EmploymentRecord[], today: ISODate) {
  const bands = [{ label: "< 1 year", max: 365 }, { label: "1–3 years", max: 365 * 3 }, { label: "3–5 years", max: 365 * 5 }, { label: "5+ years", max: Infinity }];
  const counts = bands.map(() => 0);
  for (const p of people) {
    if (!employedOn(p, today)) continue;
    const d = daysBetween(p.joining_date, today);
    counts[bands.findIndex((b) => d < b.max)]++;
  }
  return bands.map((b, i) => ({ label: b.label, n: counts[i] }));
}
