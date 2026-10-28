import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { addDaysISO, eachDay, todayIn, type ISODate } from "@/lib/dates";
import { dayType } from "@/server/modules/leave/rules";
import { calendarFor } from "@/server/modules/leave/service";

const TZ = "Asia/Kolkata";   // M0: every location is IST; per-location time zones arrive with shifts in M2

type Shift = { name: string; timings: Record<string, { start: string; end: string }>; grace_minutes: number; break_minutes: number };

async function shiftFor(tx: Tx, employeeId: string, date: ISODate) {
  const [s] = await tx<(Shift & { id: string })[]>`
    select s.id, s.name, s.timings, s.grace_minutes, s.break_minutes from shift_assignments a join shifts s on s.id = a.shift_id
    where a.employee_id = ${employeeId} and a.period @> ${date}::date limit 1`;
  return s ?? null;
}

const localMinutes = (d: Date) => {
  const [h, m] = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d).split(":").map(Number);
  return h * 60 + m;
};

/** Rebuilds one attendance day from its punches (first in → last out). Penalties and leave overlay arrive in M2. */
export async function recomputeDay(tx: Tx, tenantId: string, employeeId: string, date: ISODate) {
  const punches = await tx<{ at: Date }[]>`
    select at from punches where employee_id = ${employeeId} and status = 'valid'
      and (at at time zone ${TZ})::date = ${date}::date order by at`;
  const cal = await calendarFor(tx, employeeId);
  const type = dayType(date, cal);
  const shift = await shiftFor(tx, employeeId, date);
  const first = punches[0]?.at ?? null;
  const last = punches.length > 1 ? punches[punches.length - 1].at : null;
  // effective = sum of in→out pairs; gross = first in → last out
  let effective = 0;
  for (let i = 0; i + 1 < punches.length; i += 2) effective += (punches[i + 1].at.getTime() - punches[i].at.getTime()) / 60000;
  const gross = first && last ? (last.getTime() - first.getTime()) / 60000 : 0;
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(new Date(date + "T12:00:00Z")).toLowerCase().slice(0, 3);
  const start = shift?.timings[wd]?.start;
  const late = first && start ? Math.max(0, localMinutes(first) - (Number(start.slice(0, 2)) * 60 + Number(start.slice(3)))) : 0;
  const status = first ? "present" : type === "holiday" ? "holiday" : type === "weekly_off" ? "weekly_off" : "absent";
  await tx`
    insert into attendance_days (tenant_id, employee_id, date, shift_id, day_type, first_in, last_out, gross_minutes, effective_minutes, late_minutes, status, computed_at)
    values (${tenantId}, ${employeeId}, ${date}, ${shift?.id ?? null}, ${type}, ${first}, ${last}, ${Math.round(gross)}, ${Math.round(effective)},
            ${late > (shift?.grace_minutes ?? 0) ? late : 0}, ${status}, now())
    on conflict (employee_id, date) do update set shift_id = excluded.shift_id, day_type = excluded.day_type, first_in = excluded.first_in,
      last_out = excluded.last_out, gross_minutes = excluded.gross_minutes, effective_minutes = excluded.effective_minutes,
      late_minutes = excluded.late_minutes, status = excluded.status, computed_at = now()
    where not attendance_days.is_locked`;
}

export type TodayState = { computedAt: string; clockedIn: boolean; since: string | null; firstIn: string | null; workedSeconds: number; shift: { name: string; start: string; end: string } | null; dayType: string };

export async function today(tx: Tx, employeeId: string): Promise<TodayState> {
  const date = todayIn(TZ);
  const punches = await tx<{ at: Date }[]>`
    select at from punches where employee_id = ${employeeId} and status = 'valid' and (at at time zone ${TZ})::date = ${date}::date order by at`;
  const now = Date.now();
  let worked = 0;
  for (let i = 0; i < punches.length; i += 2) worked += ((punches[i + 1]?.at.getTime() ?? now) - punches[i].at.getTime()) / 1000;
  const shift = await shiftFor(tx, employeeId, date);
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(new Date()).toLowerCase().slice(0, 3);
  const t = shift?.timings[wd];
  const cal = await calendarFor(tx, employeeId);
  return {
    computedAt: new Date(now).toISOString(),
    clockedIn: punches.length % 2 === 1,
    since: punches.length % 2 === 1 ? punches[punches.length - 1].at.toISOString() : null,
    firstIn: punches[0]?.at.toISOString() ?? null,
    workedSeconds: Math.floor(worked),
    shift: shift && t ? { name: shift.name, start: t.start, end: t.end } : null,
    dayType: dayType(date, cal),
  };
}

/** Clock in or out (alternates). Web clock-in in M0; geofence/selfie/IP rules from the capture policy arrive in M2. */
export async function punch(tx: Tx, actor: Actor, meta: { ip: string | null; lat?: number; lng?: number; expect: "in" | "out" }) {
  await tx`select pg_advisory_xact_lock(hashtext(${"punch:" + actor.employeeId}))`;
  const state = await today(tx, actor.employeeId);
  if ((meta.expect === "in") === state.clockedIn) throw new AppError("conflict", state.clockedIn ? "You're already clocked in." : "You're already clocked out.");
  const [p] = await tx<{ at: Date }[]>`
    insert into punches (tenant_id, employee_id, at, direction, source, ip, lat, lng)
    values (${actor.tenant.id}, ${actor.employeeId}, now(), ${meta.expect}, 'web', ${meta.ip}, ${meta.lat ?? null}, ${meta.lng ?? null}) returning at`;
  await recomputeDay(tx, actor.tenant.id, actor.employeeId, todayIn(TZ));
  return { at: p.at.toISOString(), direction: meta.expect };
}

export type LogRow = { date: ISODate; dayType: string; status: string; firstIn: string | null; lastOut: string | null; gross: number; effective: number; late: number; leave: string | null };

export async function monthLog(tx: Tx, employeeId: string, month: ISODate /* YYYY-MM-01 */): Promise<LogRow[]> {
  const end = addDaysISO(`${month.slice(0, 7)}-01`, 31).slice(0, 7) + "-01";
  const last = addDaysISO(end, -1), t = todayIn(TZ);
  const [days, leaves, emp] = await Promise.all([
    tx<{ date: string; status: string; day_type: string; first_in: Date | null; last_out: Date | null; gross_minutes: number; effective_minutes: number; late_minutes: number }[]>`
      select date::text, status, day_type, first_in, last_out, gross_minutes, effective_minutes, late_minutes from attendance_days
      where employee_id = ${employeeId} and date >= ${month} and date < ${end}`,
    tx<{ from_date: string; to_date: string; name: string; days: string }[]>`
      select q.from_date::text, q.to_date::text, t.name, q.days from leave_requests q join leave_types t on t.id = q.leave_type_id
      where q.employee_id = ${employeeId} and q.status = 'approved' and q.to_date >= ${month} and q.from_date < ${end}`,
    tx<{ joining_date: string }[]>`select joining_date::text from employees where id = ${employeeId}`,
  ]);
  const cal = await calendarFor(tx, employeeId);
  const byDate = new Map(days.map((d) => [d.date, d]));
  return eachDay(month, last < t ? last : t).reverse().map((date) => {
    const d = byDate.get(date);
    const lv = leaves.find((l) => date >= l.from_date && date <= l.to_date);
    const type = dayType(date, cal);
    const status = date < emp[0].joining_date ? "not_joined" : lv && type === "working" ? "leave" : d?.status ?? (type === "working" ? (date === t ? "today" : "absent") : type);
    return { date, dayType: type, status, firstIn: d?.first_in?.toISOString() ?? null, lastOut: d?.last_out?.toISOString() ?? null,
      gross: d?.gross_minutes ?? 0, effective: d?.effective_minutes ?? 0, late: d?.late_minutes ?? 0, leave: lv?.name ?? null };
  });
}
