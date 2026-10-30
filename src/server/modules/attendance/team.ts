import "server-only";
import type { Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { addDaysISO, todayIn, type ISODate } from "@/lib/dates";
import { statuses, today as todayState } from "./service";
import { timingFor, toMin, zonedToUtc } from "./rules";
import { personFor, shiftsFor } from "./process";

export type TeamMember = { id: string; name: string; title: string | null };
export type TodayEntry = TeamMember & { state: "in" | "out" | "late" | "absent" | "not_in_yet" | "leave" | "wfh" | "on_duty" | "off"; firstIn: string | null; detail: string | null };
export type GridCell = { status: string; late: boolean; penalty: boolean; missingSwipe: boolean; pending: boolean };

/** Direct reports of the actor, a month grid of their days, today's picture and how many of their requests wait for the actor. */
export async function teamAttendance(tx: Tx, actor: Actor, month: ISODate /* YYYY-MM-01 */) {
  const members = await tx<TeamMember[]>`
    select e.id, e.display_name as name, d.title from employees e left join designations d on d.id = e.designation_id
    where e.manager_id = ${actor.employeeId} and e.status <> 'relieved' order by e.display_name`;
  const me = await personFor(tx, actor.employeeId);
  const today = todayIn(me?.tz ?? "Asia/Kolkata");
  const first = `${month.slice(0, 7)}-01`;
  const last = addDaysISO(addDaysISO(first, 32).slice(0, 8) + "01", -1);
  const ids = members.map((m) => m.id);
  const byPerson = await statuses(tx, ids, first, last, today);
  const grid: Record<string, Record<ISODate, GridCell>> = {};
  for (const m of members) {
    const days = byPerson.get(m.id)!;
    grid[m.id] = Object.fromEntries([...days.entries()].map(([d, r]) => [d, {
      status: r.status, late: r.late > 0, penalty: r.penalties.some((p) => p.days > 0), missingSwipe: r.missingSwipe,
      pending: r.requests.some((q) => q.status === "pending"),
    }]));
  }

  // today
  const now = new Date();
  const todayRows = ids.length ? (await statuses(tx, ids, today, today, today)) : new Map();
  const entries: TodayEntry[] = [];
  for (const m of members) {
    const row = todayRows.get(m.id)?.get(today);
    const st = await todayState(tx, m.id);
    const person = await personFor(tx, m.id);
    const shiftOn = await shiftsFor(tx, m.id, today, today);
    const t = timingFor(shiftOn(today), today);
    const shift = shiftOn(today);
    const lateBy = st.firstIn && t && shift?.kind === "fixed" ? Math.round((Date.parse(st.firstIn) - zonedToUtc(today, toMin(t.start), person?.tz ?? "Asia/Kolkata").getTime()) / 60000) : 0;
    const startPassed = t ? now.getTime() > zonedToUtc(today, toMin(t.start) + (shift?.grace_minutes ?? 0), person?.tz ?? "Asia/Kolkata").getTime() : false;
    let state: TodayEntry["state"], detail: string | null = null;
    if (row?.status === "leave") { state = "leave"; detail = row.leave; }
    else if (st.capture.remoteToday && !st.firstIn) state = st.capture.remoteToday;
    else if (st.firstIn) { state = lateBy > (shift?.grace_minutes ?? 0) ? "late" : st.clockedIn ? "in" : "out"; if (state === "late") detail = `${lateBy} min late`; }
    else if (st.dayType === "weekly_off" || st.dayType === "holiday" || row?.status === "not_joined") state = "off";
    else if (row?.status === "half_leave") { state = "leave"; detail = `${row.leave ?? "Leave"} · half day`; }
    else state = startPassed ? "absent" : "not_in_yet";
    if (state === "late" && !st.clockedIn) detail = `${detail} · clocked out`;
    entries.push({ ...m, state, firstIn: st.firstIn, detail });
  }

  const [{ pending, attendance }] = ids.length
    ? await tx<{ pending: number; attendance: number }[]>`
        select count(*)::int as pending, count(*) filter (where r.entity_type = 'attendance_request')::int as attendance
        from approval_steps s join approval_requests r on r.id = s.request_id
        where s.approver_employee_id = ${actor.employeeId} and s.status = 'pending' and r.requester_employee_id = any(${ids}::uuid[])`
    : [{ pending: 0, attendance: 0 }];
  return { members, grid, today, first, last, entries, pending, pendingAttendance: attendance };
}
