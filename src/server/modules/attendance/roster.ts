import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { addDaysISO, todayIn, type ISODate } from "@/lib/dates";
import { notify } from "@/server/modules/notifications/service";
import { canManagePolicies } from "./policies";
import { calendarFor, reprocessFrom, rosterFor, shiftsFor } from "./process";
import { expandRotation, validateRotation, validateShiftRule, weekDays, weekStartOf, type Rotation, type RosterEntryInput, type RosterValue } from "./roster-rules";

/**
 * The roster board: people × days, each cell a shift from the roster, their assignment or the company default.
 * Writing roster_entries (which attendance processing honours over the dated assignment) is scoped: an admin for
 * Engineering can only roster Engineering people. Shift / weekly-off change rules are company-wide.
 */

const PERM = "attendance.admin";
const assertPolicies = (actor: Actor) => { if (!canManagePolicies(actor)) throw new AppError("forbidden", "You don't have access to change time settings."); };
async function audit(tx: Tx, actor: Actor, entity: string, id: string, action: string, diff: unknown) {
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${actor.tenant.id}, ${actor.userId}, ${entity}, ${id}, ${action}, ${tx.json(diff as never)})`;
}

export type RosterCell = { value: RosterValue; label: string; source: "roster" | "assignment" | "default"; dayType: string; locked: boolean };
export type RosterPerson = { id: string; name: string; title: string | null; department: string | null; cells: Record<ISODate, RosterCell> };
export type RosterWeek = { weekStart: ISODate; days: ISODate[]; today: ISODate; people: RosterPerson[]; shifts: { id: string; name: string; code: string }[]; total: number };

export async function rosterWeek(tx: Tx, actor: Actor, dateInput: ISODate, q = ""): Promise<RosterWeek> {
  const weekStart = weekStartOf(dateInput);
  const days = weekDays(weekStart);
  const today = todayIn();
  const term = q.trim().toLowerCase();
  const all = await tx<(Placement & { id: string; name: string; title: string | null; department: string | null; number: string })[]>`
    select e.id, e.display_name as name, dg.title, dp.name as department, e.employee_number as number, e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id
    from employees e left join departments dp on dp.id = e.department_id left join designations dg on dg.id = e.designation_id
    where e.status <> 'relieved' and e.joining_date <= ${days[6]} and (e.exit_date is null or e.exit_date >= ${days[0]}) order by e.display_name`;
  const visible = all.filter((p) => canFor(actor, PERM, p)).filter((p) => !term || [p.name, p.number, p.department ?? "", p.title ?? ""].some((x) => x.toLowerCase().includes(term)));
  const shifts = await tx<{ id: string; name: string; code: string }[]>`select id, name, code from shifts order by created_at, id`;
  const locked = await tx<{ employee_id: string; date: string }[]>`
    select employee_id, date::text from attendance_days where is_locked and date between ${days[0]} and ${days[6]} and employee_id = any(${visible.slice(0, 200).map((p) => p.id)}::uuid[])`;
  const lockedSet = new Set(locked.map((l) => `${l.employee_id}:${l.date}`));
  const people: RosterPerson[] = [];
  for (const p of visible.slice(0, 200)) {   // a week board for up to 200 people; search narrows bigger companies
    const roster = await rosterFor(tx, p.id, days[0], days[6]);
    const shiftOn = await shiftsFor(tx, p.id, days[0], days[6]);
    const typeOn = await calendarFor(tx, p.id, days[0], days[6]);
    const cells: Record<ISODate, RosterCell> = {};
    for (const d of days) {
      const t = typeOn(d);
      const s = shiftOn(d);
      const inRoster = roster.has(d);
      const off = inRoster ? roster.get(d) === null : t === "weekly_off";
      cells[d] = {
        value: inRoster ? (roster.get(d)?.id ?? "off") : null,
        label: t === "holiday" ? "Holiday" : off ? "Off" : t === "half_weekly_off" ? `${s?.code ?? "—"} ½` : s?.code ?? "—",
        source: inRoster ? "roster" : s ? "assignment" : "default",
        dayType: t, locked: lockedSet.has(`${p.id}:${d}`),
      };
    }
    people.push({ id: p.id, name: p.name, title: p.title, department: p.department, cells });
  }
  return { weekStart, days, today, people, shifts, total: visible.length };
}

/** Write roster cells. value: a shift id, "off", or null to clear back to the regular assignment. Past days are re-processed. */
export async function saveRoster(tx: Tx, actor: Actor, entries: RosterEntryInput[]) {
  if (!entries.length) throw new AppError("invalid", "Nothing to save.");
  if (entries.length > 5000) throw new AppError("invalid", "Save at most 5000 cells at a time.");
  const today = todayIn();
  const ids = [...new Set(entries.map((e) => e.employeeId))];
  const people = await tx<(Placement & { id: string; name: string })[]>`
    select id, display_name as name, department_id, location_id, legal_entity_id, business_unit_id from employees where id = any(${ids}::uuid[]) and status <> 'relieved'`;
  if (people.length !== ids.length) throw new AppError("not_found", "Some of these people are no longer active.");
  const outside = people.filter((p) => !canFor(actor, PERM, p));
  if (outside.length) throw new AppError("forbidden", `You can't roster ${outside[0].name}${outside.length > 1 ? ` and ${outside.length - 1} more` : ""}.`);
  const shiftIds = [...new Set(entries.map((e) => e.value).filter((v): v is string => !!v && v !== "off"))];
  if (shiftIds.length) {
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from shifts where id = any(${shiftIds}::uuid[])`;
    if (n !== shiftIds.length) throw new AppError("not_found", "One of those shifts no longer exists.");
  }
  for (const e of entries) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) throw new AppError("invalid", "Bad date.");
    if (e.date < addDaysISO(today, -31) || e.date > addDaysISO(today, 366)) throw new AppError("invalid", "Roster days can be up to a month back or a year ahead.");
  }
  const locked = await tx<{ employee_id: string; date: string }[]>`
    select employee_id, date::text from attendance_days where is_locked and employee_id = any(${ids}::uuid[]) and date = any(${entries.map((e) => e.date)}::date[])`;
  const lockedSet = new Set(locked.map((l) => `${l.employee_id}:${l.date}`));
  const touched = new Map<string, { from: ISODate; to: ISODate; future: boolean }>();
  let changed = 0;
  for (const e of entries) {
    if (lockedSet.has(`${e.employeeId}:${e.date}`)) continue;   // payroll finalised that day
    const r = e.value === null
      ? await tx`delete from roster_entries where employee_id = ${e.employeeId} and date = ${e.date}`
      : await tx`insert into roster_entries (tenant_id, employee_id, date, shift_id) values (${actor.tenant.id}, ${e.employeeId}, ${e.date}, ${e.value === "off" ? null : e.value})
                 on conflict (employee_id, date) do update set shift_id = excluded.shift_id where roster_entries.shift_id is distinct from excluded.shift_id`;
    if (!r.count) continue;
    changed++;
    const t = touched.get(e.employeeId) ?? { from: e.date, to: e.date, future: false };
    if (e.date < t.from) t.from = e.date;
    if (e.date > t.to) t.to = e.date;
    if (e.date >= today) t.future = true;
    touched.set(e.employeeId, t);
  }
  for (const [id, t] of touched) {
    if (t.from <= today) await reprocessFrom(tx, actor.tenant.id, id, t.from, t.to < today ? t.to : today);
    if (t.future && id !== actor.employeeId) await notify(tx, actor.tenant.id, [id], "attendance.roster", "Your roster changed", `${actor.name} updated your shifts for ${t.from === t.to ? t.from : `${t.from} to ${t.to}`}.`, "/me/attendance");
  }
  await audit(tx, actor, "roster", ids[0], "update", { employeeIds: ids, cells: entries.length, changed });
  return { changed, skippedLocked: entries.length - changed };
}

/** Apply a weekly pattern or a repeating cycle to people from a start date for N days. */
export async function applyRotation(tx: Tx, actor: Actor, input: { employeeIds: string[]; rotation: Rotation; start: ISODate; days: number }) {
  const err = validateRotation(input.rotation, input.days);
  if (err) throw new AppError("invalid", err);
  const ids = [...new Set(input.employeeIds)];
  if (!ids.length) throw new AppError("invalid", "Choose at least one person.");
  const entries = ids.flatMap((id) => expandRotation(input.rotation, id, input.start, input.days));
  if (!entries.length) throw new AppError("invalid", "That pattern doesn't set any day.");
  const r = await saveRoster(tx, actor, entries);
  await audit(tx, actor, "roster", ids[0], "rotation", { employeeIds: ids, rotation: input.rotation, start: input.start, days: input.days });
  return r;
}

// ---------------------------------------------------------------- shift & weekly-off change rules

export type ShiftRuleRow = { id: string; name: string; allowed_shift_ids: string[]; allowed: string[]; request_window_days: number | null; max_requests_per_month: number | null; allow_on_off_days: boolean; is_default: boolean };

export async function listShiftRules(tx: Tx): Promise<ShiftRuleRow[]> {
  const rows = await tx<Omit<ShiftRuleRow, "allowed" | "is_default">[]>`select id, name, allowed_shift_ids, request_window_days, max_requests_per_month, allow_on_off_days from shift_rules order by created_at, id`;
  const shifts = await tx<{ id: string; name: string }[]>`select id, name from shifts`;
  const nameOf = new Map(shifts.map((s) => [s.id, s.name]));
  return rows.map((r, i) => ({ ...r, allowed: r.allowed_shift_ids.map((id) => nameOf.get(id) ?? "?"), is_default: i === 0 }));
}

export async function saveShiftRule(tx: Tx, actor: Actor, id: string | null, input: { name: string; allowedShiftIds: string[]; requestWindowDays: number | null; maxRequestsPerMonth: number | null; allowOnOffDays: boolean }) {
  assertPolicies(actor);
  const name = input.name.trim();
  const err = validateShiftRule({ name, request_window_days: input.requestWindowDays, max_requests_per_month: input.maxRequestsPerMonth });
  if (err) throw new AppError("invalid", err);
  const allowed = [...new Set(input.allowedShiftIds)];
  if (allowed.length) {
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from shifts where id = any(${allowed}::uuid[])`;
    if (n !== allowed.length) throw new AppError("invalid", "One of the chosen shifts no longer exists.");
  }
  const row = id
    ? await tx<{ id: string }[]>`update shift_rules set name = ${name}, allowed_shift_ids = ${allowed}::uuid[], request_window_days = ${input.requestWindowDays}, max_requests_per_month = ${input.maxRequestsPerMonth}, allow_on_off_days = ${input.allowOnOffDays} where id = ${id} returning id`
    : await tx<{ id: string }[]>`insert into shift_rules (tenant_id, name, allowed_shift_ids, request_window_days, max_requests_per_month, allow_on_off_days) values (${actor.tenant.id}, ${name}, ${allowed}::uuid[], ${input.requestWindowDays}, ${input.maxRequestsPerMonth}, ${input.allowOnOffDays}) returning id`;
  if (!row[0]) throw new AppError("not_found", "This rule no longer exists.");
  await audit(tx, actor, "shift_rule", row[0].id, id ? "update" : "create", { ...input, name, allowedShiftIds: allowed });
  return { id: row[0].id };
}

export async function deleteShiftRule(tx: Tx, actor: Actor, id: string) {
  assertPolicies(actor);
  await tx`delete from shift_rules where id = ${id}`;
  await audit(tx, actor, "shift_rule", id, "delete", {});
}
