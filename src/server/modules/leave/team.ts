import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { addDaysISO, eachDay, weekday } from "@/lib/dates";
import { addMonthsISO } from "./accrual-rules";
import { canAdminLeaveFor, hasAnyLeaveAdmin } from "./access";
import { dayType } from "./rules";
import { calendarFor } from "./service";

export type TeamCell = { kind: "leave" | "pending" | "holiday" | "weekly_off"; label: string; code?: string; color?: string; half?: "first" | "second" };
export type TeamPerson = { id: string; name: string; title: string | null; isMe: boolean; cells: Record<string, TeamCell> };
export type TeamMonth = {
  month: string; prev: string; next: string; view: "team" | "all"; canSeeAll: boolean;
  days: { date: string; day: number; weekday: string }[]; people: TeamPerson[]; types: { code: string; name: string; color: string }[];
};

const MAX_PEOPLE = 150;

/**
 * Who's off in a month. 'team' = you, your direct reports and the people who share your manager.
 * 'all' (leave admins) = everyone you administer. Pending leave is shown separately from approved.
 */
export async function teamLeaveMonth(tx: Tx, actor: Actor, input: { month: string; view?: string }): Promise<TeamMonth> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)) throw new AppError("invalid", "Pick a month.");
  const canSeeAll = hasAnyLeaveAdmin(actor);
  const view = input.view === "all" && canSeeAll ? "all" : "team";
  const from = `${input.month}-01`, to = addDaysISO(addMonthsISO(from, 1), -1);
  type P = { id: string; name: string; title: string | null; department_id: string | null; location_id: string | null; legal_entity_id: string | null; business_unit_id: string | null };
  let people: P[] = await tx<P[]>`
    select e.id, e.display_name as name, d.title, e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id
    from employees e left join designations d on d.id = e.designation_id
    where e.status <> 'relieved' and e.joining_date <= ${to}
      and (${view} = 'all' or e.id = ${actor.employeeId} or e.manager_id = ${actor.employeeId}
           or (e.manager_id is not null and e.manager_id = (select manager_id from employees where id = ${actor.employeeId})))
    order by e.id = ${actor.employeeId} desc, e.display_name`;
  if (view === "all") people = people.filter((p) => p.id === actor.employeeId || canAdminLeaveFor(actor, p));
  people = people.slice(0, MAX_PEOPLE);
  const ids = people.map((p) => p.id);
  const leaves = await tx<{ employee_id: string; from_date: string; to_date: string; from_half: string; to_half: string; status: string; code: string; name: string; color: string }[]>`
    select q.employee_id, q.from_date::text, q.to_date::text, q.from_half, q.to_half, q.status, t.code, t.name, t.color
    from leave_requests q join leave_types t on t.id = q.leave_type_id
    where q.employee_id = any(${ids}::uuid[]) and q.status in ('pending', 'approved') and q.from_date <= ${to} and q.to_date >= ${from}`;
  const days = eachDay(from, to).map((d) => ({ date: d, day: Number(d.slice(8)), weekday: weekday(d) }));
  const out: TeamPerson[] = [];
  for (const p of people) {
    const cal = await calendarFor(tx, p.id);
    const cells: Record<string, TeamCell> = {};
    for (const { date } of days) {
      const t = dayType(date, cal);
      if (t === "holiday") cells[date] = { kind: "holiday", label: "Holiday" };
      else if (t === "weekly_off") cells[date] = { kind: "weekly_off", label: "Weekly off" };
    }
    for (const l of leaves.filter((x) => x.employee_id === p.id)) {
      for (const date of eachDay(l.from_date < from ? from : l.from_date, l.to_date > to ? to : l.to_date)) {
        if (cells[date]?.kind === "holiday" || cells[date]?.kind === "weekly_off") continue;
        const half = date === l.from_date && l.from_half === "second" ? "second" : date === l.to_date && l.to_half === "first" ? "first" : undefined;
        cells[date] = { kind: l.status === "approved" ? "leave" : "pending", code: l.code, color: l.color, half,
          label: `${l.name}${half ? half === "first" ? " (first half)" : " (second half)" : ""}${l.status === "pending" ? ", waiting for approval" : ""}` };
      }
    }
    out.push({ id: p.id, name: p.name, title: p.title, isMe: p.id === actor.employeeId, cells });
  }
  const types = [...new Map(leaves.map((l) => [l.code, { code: l.code, name: l.name, color: l.color }])).values()];
  return { month: input.month, prev: addMonthsISO(from, -1).slice(0, 7), next: addMonthsISO(from, 1).slice(0, 7), view, canSeeAll, days, people: out, types };
}
