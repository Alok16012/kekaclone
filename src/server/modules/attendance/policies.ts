import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { addDaysISO, todayIn, type ISODate } from "@/lib/dates";
import {
  WEEK, isValidCidr, patternFromGrid, validatePenaltyPolicy, validateShift,
  type CapturePolicy, type DayTiming, type OffValue, type PenaltyPolicy, type Weekday,
} from "./rules";
import { reprocessFrom } from "./process";

/**
 * Time settings: shifts, weekly offs, capture policies (with geofences), penalization policies and who gets which.
 * Policies are company-wide, so editing them needs attendance.admin without a scope. Assigning people respects
 * scoped roles: an HR admin for Engineering can only assign Engineering people.
 */

const PERM = "attendance.admin";
const NOWHERE: Placement = { department_id: null, location_id: null, legal_entity_id: null, business_unit_id: null };
/** Granted company-wide (no department / location scope). */
export const canManagePolicies = (actor: Actor) => canFor(actor, PERM, NOWHERE);
/** Granted anywhere, scoped or not: can open the assignments page for their people. */
export const canAssignSomeone = (actor: Actor) => (actor.grants ?? []).some((g) => g.permissions.includes("*") || g.permissions.includes(PERM));
const assertPolicies = (actor: Actor) => { if (!canManagePolicies(actor)) throw new AppError("forbidden", "You don't have access to change time settings."); };

async function audit(tx: Tx, actor: Actor, entity: string, id: string, action: string, diff: unknown) {
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${actor.tenant.id}, ${actor.userId}, ${entity}, ${id}, ${action}, ${tx.json(diff as never)})`;
}

/** Insert/update that turns a unique violation into a friendly message without aborting the transaction. */
async function guarded<T>(tx: Tx, fn: (sp: Tx) => Promise<T>, message: string, field?: string): Promise<T> {
  try {
    return (await tx.savepoint((sp) => fn(sp as unknown as Tx))) as T;
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new AppError("conflict", message, field);
    throw e;
  }
}

// ---------------------------------------------------------------- shifts

export type ShiftRow = { id: string; name: string; code: string; kind: "fixed" | "flexible"; timings: Partial<Record<Weekday, DayTiming>>; break_minutes: number; grace_minutes: number; half_day_minutes: number | null; auto_assign: { from: string; to: string } | null; people: number; is_default: boolean };

export async function listShifts(tx: Tx, today: ISODate): Promise<ShiftRow[]> {
  return tx<ShiftRow[]>`
    select s.id, s.name, s.code, s.kind, s.timings, s.break_minutes, s.grace_minutes, s.half_day_minutes, s.auto_assign,
      (select count(*)::int from shift_assignments a join employees e on e.id = a.employee_id and e.status <> 'relieved' where a.shift_id = s.id and a.period @> ${today}::date) as people,
      s.id = (select id from shifts order by created_at, id limit 1) as is_default
    from shifts s order by s.created_at, s.id`;
}

export type ShiftInput = { name: string; code: string; kind: "fixed" | "flexible"; timings: Partial<Record<Weekday, DayTiming | null>>; break_minutes: number; grace_minutes: number; half_day_minutes: number | null; auto_assign?: { from: string; to: string } | null };

export async function saveShift(tx: Tx, actor: Actor, id: string | null, input: ShiftInput) {
  assertPolicies(actor);
  const s = { ...input, name: input.name.trim(), code: input.code.trim().toUpperCase() };
  const err = validateShift({ ...s, auto_assign: s.auto_assign ? { start: s.auto_assign.from, end: s.auto_assign.to } : null });
  if (err) throw new AppError("invalid", err);
  const timings = Object.fromEntries(WEEK.filter((d) => s.timings[d]).map((d) => [d, { start: s.timings[d]!.start, end: s.timings[d]!.end }]));
  const auto = s.auto_assign ? { from: s.auto_assign.from, to: s.auto_assign.to } : null;
  const row = await guarded(tx, (sp) => id
    ? sp<{ id: string }[]>`update shifts set name = ${s.name}, code = ${s.code}, kind = ${s.kind}, timings = ${sp.json(timings)}, break_minutes = ${s.break_minutes},
        grace_minutes = ${s.grace_minutes}, half_day_minutes = ${s.half_day_minutes}, auto_assign = ${auto ? sp.json(auto) : null} where id = ${id} returning id`
    : sp<{ id: string }[]>`insert into shifts (tenant_id, name, code, kind, timings, break_minutes, grace_minutes, half_day_minutes, auto_assign)
        values (${actor.tenant.id}, ${s.name}, ${s.code}, ${s.kind}, ${sp.json(timings)}, ${s.break_minutes}, ${s.grace_minutes}, ${s.half_day_minutes}, ${auto ? sp.json(auto) : null}) returning id`,
    "Another shift already uses this code.", "code");
  if (!row[0]) throw new AppError("not_found", "This shift no longer exists.");
  await audit(tx, actor, "shift", row[0].id, id ? "update" : "create", s);
  return { id: row[0].id };
}

export async function deleteShift(tx: Tx, actor: Actor, id: string) {
  assertPolicies(actor);
  const [{ used, total }] = await tx<{ used: number; total: number }[]>`
    select (select count(*)::int from shift_assignments where shift_id = ${id}) + (select count(*)::int from roster_entries where shift_id = ${id}) as used,
           (select count(*)::int from shifts) as total`;
  if (used) throw new AppError("conflict", "People have been on this shift, so it can't be deleted. Move them to another shift instead.");
  if (total <= 1) throw new AppError("conflict", "Keep at least one shift.");
  await tx`delete from shifts where id = ${id}`;
  await audit(tx, actor, "shift", id, "delete", {});
}

// ---------------------------------------------------------------- weekly offs

export type WeeklyOffRow = { id: string; name: string; pattern: Partial<Record<Weekday, OffValue | OffValue[]>>; people: number; is_default: boolean };

export async function listWeeklyOffs(tx: Tx, today: ISODate): Promise<WeeklyOffRow[]> {
  return tx<WeeklyOffRow[]>`
    select p.id, p.name, p.pattern,
      (select count(*)::int from weekly_off_assignments a join employees e on e.id = a.employee_id and e.status <> 'relieved' where a.policy_id = p.id and a.period @> ${today}::date) as people,
      p.id = (select id from weekly_off_policies order by created_at, id limit 1) as is_default
    from weekly_off_policies p order by p.created_at, p.id`;
}

export async function saveWeeklyOff(tx: Tx, actor: Actor, id: string | null, input: { name: string; grid: Record<string, unknown> }) {
  assertPolicies(actor);
  const name = input.name.trim();
  if (!name || name.length > 80) throw new AppError("invalid", "Give the policy a name (up to 80 characters).", "name");
  const { pattern, error } = patternFromGrid(input.grid);
  if (error) throw new AppError("invalid", error);
  const row = await guarded(tx, (sp) => id
    ? sp<{ id: string }[]>`update weekly_off_policies set name = ${name}, pattern = ${sp.json(pattern)} where id = ${id} returning id`
    : sp<{ id: string }[]>`insert into weekly_off_policies (tenant_id, name, pattern) values (${actor.tenant.id}, ${name}, ${sp.json(pattern)}) returning id`,
    "Another weekly-off policy already has this name.", "name");
  if (!row[0]) throw new AppError("not_found", "This policy no longer exists.");
  await audit(tx, actor, "weekly_off_policy", row[0].id, id ? "update" : "create", { name, pattern });
  return { id: row[0].id };
}

export async function deleteWeeklyOff(tx: Tx, actor: Actor, id: string) {
  assertPolicies(actor);
  const [{ used, total }] = await tx<{ used: number; total: number }[]>`
    select (select count(*)::int from weekly_off_assignments where policy_id = ${id}) as used, (select count(*)::int from weekly_off_policies) as total`;
  if (used) throw new AppError("conflict", "This policy has been assigned to people, so it can't be deleted.");
  if (total <= 1) throw new AppError("conflict", "Keep at least one weekly-off policy.");
  await tx`delete from weekly_off_policies where id = ${id}`;
  await audit(tx, actor, "weekly_off_policy", id, "delete", {});
}

// ---------------------------------------------------------------- capture policies + geofences

export type FenceInput = { id?: string | null; name: string; lat: number; lng: number; radius_m: number };
export type CaptureRow = { id: string; name: string; web: CapturePolicy["web"]; mobile: CapturePolicy["mobile"]; remote: CapturePolicy["remote"]; limits: CapturePolicy["limits"]; fences: (FenceInput & { id: string })[]; people: number; is_default: boolean };

export async function listCapture(tx: Tx): Promise<CaptureRow[]> {
  const rows = await tx<Omit<CaptureRow, "fences">[]>`
    select c.id, c.name, c.web, c.mobile, c.remote, c.limits,
      (select count(*)::int from employees e where e.status <> 'relieved' and (e.capture_policy_id = c.id
        or (e.capture_policy_id is null and c.id = (select id from capture_policies order by created_at, id limit 1)))) as people,
      c.id = (select id from capture_policies order by created_at, id limit 1) as is_default
    from capture_policies c order by c.created_at, c.id`;
  const fences = await tx<(FenceInput & { id: string })[]>`select id, name, lat, lng, radius_m from geofences order by name`;
  const D = { web: { enabled: true, comment_required: false, ip_ranges: [] as string[] }, mobile: { enabled: true, geofence_ids: [] as string[] },
    remote: { wfh: true, od: true }, limits: { regularization_per_month: 3, regularization_past_days: 7, partial_day_minutes_per_month: 240 } };
  return rows.map((r) => ({
    ...r,
    web: Object.assign({}, D.web, r.web), mobile: Object.assign({}, D.mobile, r.mobile),
    remote: Object.assign({}, D.remote, r.remote), limits: Object.assign({}, D.limits, r.limits),
    fences: fences.filter((f) => (r.mobile?.geofence_ids ?? []).includes(f.id)),
  }));
}

export type CaptureInput = {
  name: string;
  web: { enabled: boolean; comment_required: boolean; ip_ranges: string[] };
  mobile: { enabled: boolean; fences: FenceInput[] };
  remote: { wfh: boolean; od: boolean };
  limits: CapturePolicy["limits"];
};

const intIn = (n: number, lo: number, hi: number) => Number.isInteger(n) && n >= lo && n <= hi;

export async function saveCapture(tx: Tx, actor: Actor, id: string | null, input: CaptureInput) {
  assertPolicies(actor);
  const name = input.name.trim();
  if (!name || name.length > 80) throw new AppError("invalid", "Give the policy a name (up to 80 characters).", "name");
  const ranges = [...new Set(input.web.ip_ranges.map((r) => r.trim()).filter(Boolean))];
  const bad = ranges.find((r) => !isValidCidr(r));
  if (bad) throw new AppError("invalid", `"${bad.slice(0, 60)}" isn't an IP address or range. Use forms like 203.0.113.10 or 10.0.0.0/8.`, "ip_ranges");
  if (ranges.length > 50) throw new AppError("invalid", "Add at most 50 IP ranges.", "ip_ranges");
  if (input.mobile.fences.length > 20) throw new AppError("invalid", "Add at most 20 locations.");
  for (const f of input.mobile.fences) {
    if (!f.name.trim()) throw new AppError("invalid", "Give every location a name.");
    if (!(Number.isFinite(f.lat) && Math.abs(f.lat) <= 90 && Number.isFinite(f.lng) && Math.abs(f.lng) <= 180)) throw new AppError("invalid", `Check the latitude and longitude of ${f.name.trim()}.`);
    if (!intIn(f.radius_m, 20, 5000)) throw new AppError("invalid", `The radius of ${f.name.trim()} must be between 20 and 5000 metres.`);
  }
  if (input.mobile.enabled && !input.mobile.fences.length && !input.web.enabled) throw new AppError("invalid", "Turn on browser clock-in, or add at least one location for location-based clock-in.");
  const l = input.limits;
  if (!intIn(l.regularization_per_month, 0, 31) || !intIn(l.regularization_past_days, 0, 90) || !intIn(l.partial_day_minutes_per_month, 0, 2400)) {
    throw new AppError("invalid", "Check the limits: up to 31 regularizations a month, up to 90 days back, up to 40 hours of partial days.");
  }

  const [existing] = id ? await tx<{ mobile: { geofence_ids?: string[] } }[]>`select mobile from capture_policies where id = ${id}` : [];
  if (id && !existing) throw new AppError("not_found", "This policy no longer exists.");
  const owned = new Set(existing?.mobile.geofence_ids ?? []);
  const keep: string[] = [];
  for (const f of input.mobile.fences) {
    if (f.id && owned.has(f.id)) {
      await tx`update geofences set name = ${f.name.trim()}, lat = ${f.lat}, lng = ${f.lng}, radius_m = ${f.radius_m} where id = ${f.id}`;
      keep.push(f.id);
    } else {
      const [g] = await tx<{ id: string }[]>`insert into geofences (tenant_id, name, lat, lng, radius_m) values (${actor.tenant.id}, ${f.name.trim()}, ${f.lat}, ${f.lng}, ${f.radius_m}) returning id`;
      keep.push(g.id);
    }
  }
  const removed = [...owned].filter((g) => !keep.includes(g));
  if (removed.length) await tx`delete from geofences where id = any(${removed}::uuid[])`;

  const web = { enabled: input.web.enabled, comment_required: input.web.comment_required, ip_ranges: ranges };
  const mobile = { enabled: input.mobile.enabled, geofence_ids: keep, selfie: false, first_clock_in_approval: false };
  const row = await guarded(tx, (sp) => id
    ? sp<{ id: string }[]>`update capture_policies set name = ${name}, web = ${sp.json(web)}, mobile = ${sp.json(mobile)}, remote = ${sp.json(input.remote)}, limits = ${sp.json(l)} where id = ${id} returning id`
    : sp<{ id: string }[]>`insert into capture_policies (tenant_id, name, web, mobile, remote, limits) values (${actor.tenant.id}, ${name}, ${sp.json(web)}, ${sp.json(mobile)}, ${sp.json(input.remote)}, ${sp.json(l)}) returning id`,
    "Another capture policy already has this name.", "name");
  await audit(tx, actor, "capture_policy", row[0].id, id ? "update" : "create", { name, web, mobile, remote: input.remote, limits: l });
  return { id: row[0].id };
}

export async function deleteCapture(tx: Tx, actor: Actor, id: string) {
  assertPolicies(actor);
  const [p] = await tx<{ mobile: { geofence_ids?: string[] }; used: number; is_default: boolean }[]>`
    select mobile, (select count(*)::int from employees where capture_policy_id = ${id}) as used,
      id = (select id from capture_policies order by created_at, id limit 1) as is_default from capture_policies where id = ${id}`;
  if (!p) throw new AppError("not_found", "This policy no longer exists.");
  if (p.is_default) throw new AppError("conflict", "This is the company default for everyone without a policy, so it can't be deleted.");
  if (p.used) throw new AppError("conflict", "People are on this policy. Move them to another one first.");
  await tx`delete from capture_policies where id = ${id}`;
  if (p.mobile.geofence_ids?.length) await tx`delete from geofences where id = any(${p.mobile.geofence_ids}::uuid[])`;
  await audit(tx, actor, "capture_policy", id, "delete", {});
}

// ---------------------------------------------------------------- penalization policies

export type PenaltyRow = PenaltyPolicy & { id: string; name: string; deduct_from_leave_type_ids: string[]; people: number };

export async function listPenalties(tx: Tx): Promise<PenaltyRow[]> {
  return tx<PenaltyRow[]>`
    select p.id, p.name, p.late_arrival, p.hours_shortage, p.no_attendance, p.missing_swipe, p.deduct_from_leave_type_ids,
      (select count(*)::int from employees e where e.penalization_policy_id = p.id and e.status <> 'relieved') as people
    from penalization_policies p order by p.created_at, p.id`;
}

export async function savePenalty(tx: Tx, actor: Actor, id: string | null, input: PenaltyPolicy & { name: string; deduct_from: string[] }) {
  assertPolicies(actor);
  const name = input.name.trim();
  if (!name || name.length > 80) throw new AppError("invalid", "Give the policy a name (up to 80 characters).", "name");
  const err = validatePenaltyPolicy(input);
  if (err) throw new AppError("invalid", err);
  const order = [...new Set(input.deduct_from)].slice(0, 5);
  if (order.length) {
    const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from leave_types where id = any(${order}::uuid[])`;
    if (n !== order.length) throw new AppError("invalid", "One of the chosen leave types no longer exists.");
  }
  const j = (v: unknown) => (v ? tx.json(v as never) : null);
  const row = await guarded(tx, (sp) => id
    ? sp<{ id: string }[]>`update penalization_policies set name = ${name}, late_arrival = ${j(input.late_arrival)}, hours_shortage = ${j(input.hours_shortage)},
        no_attendance = ${j(input.no_attendance)}, missing_swipe = ${j(input.missing_swipe)}, deduct_from_leave_type_ids = ${order}::uuid[] where id = ${id} returning id`
    : sp<{ id: string }[]>`insert into penalization_policies (tenant_id, name, late_arrival, hours_shortage, no_attendance, missing_swipe, deduct_from_leave_type_ids)
        values (${actor.tenant.id}, ${name}, ${j(input.late_arrival)}, ${j(input.hours_shortage)}, ${j(input.no_attendance)}, ${j(input.missing_swipe)}, ${order}::uuid[]) returning id`,
    "Another penalty policy already has this name.", "name");
  if (!row[0]) throw new AppError("not_found", "This policy no longer exists.");
  await audit(tx, actor, "penalization_policy", row[0].id, id ? "update" : "create", { ...input, name, deduct_from: order });
  return { id: row[0].id };
}

export async function deletePenalty(tx: Tx, actor: Actor, id: string) {
  assertPolicies(actor);
  const [{ used }] = await tx<{ used: number }[]>`select count(*)::int as used from employees where penalization_policy_id = ${id}`;
  if (used) throw new AppError("conflict", "People are on this policy. Move them to another one (or none) first.");
  await tx`delete from penalization_policies where id = ${id}`;
  await audit(tx, actor, "penalization_policy", id, "delete", {});
}

// ---------------------------------------------------------------- assignments

export type AssignmentRow = {
  id: string; name: string; number: string; department: string | null; title: string | null;
  shift: string | null; shift_from: string | null; next_shift: string | null; next_shift_from: string | null;
  weekly_off: string | null; next_weekly_off: string | null; next_weekly_off_from: string | null;
  capture: string | null; penalty: string | null; overtime: string | null;
};

export async function listAssignments(tx: Tx, actor: Actor, today: ISODate): Promise<AssignmentRow[]> {
  const rows = await tx<(AssignmentRow & Placement)[]>`
    select e.id, e.display_name as name, e.employee_number as number, dp.name as department, dg.title,
      e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id,
      cs.name as shift, lower(ca.period)::text as shift_from, ns.name as next_shift, lower(na.period)::text as next_shift_from,
      cw.name as weekly_off, nw.name as next_weekly_off, lower(nwa.period)::text as next_weekly_off_from,
      coalesce(cp.name, (select name from capture_policies order by created_at, id limit 1) || ' (default)') as capture, pp.name as penalty, op.name as overtime
    from employees e
    left join departments dp on dp.id = e.department_id left join designations dg on dg.id = e.designation_id
    left join shift_assignments ca on ca.employee_id = e.id and ca.period @> ${today}::date left join shifts cs on cs.id = ca.shift_id
    left join lateral (select * from shift_assignments x where x.employee_id = e.id and lower(x.period) > ${today}::date order by lower(x.period) limit 1) na on true
    left join shifts ns on ns.id = na.shift_id
    left join weekly_off_assignments cwa on cwa.employee_id = e.id and cwa.period @> ${today}::date left join weekly_off_policies cw on cw.id = cwa.policy_id
    left join lateral (select * from weekly_off_assignments x where x.employee_id = e.id and lower(x.period) > ${today}::date order by lower(x.period) limit 1) nwa on true
    left join weekly_off_policies nw on nw.id = nwa.policy_id
    left join capture_policies cp on cp.id = e.capture_policy_id
    left join penalization_policies pp on pp.id = e.penalization_policy_id
    left join overtime_policies op on op.id = e.overtime_policy_id
    where e.status <> 'relieved' order by e.display_name`;
  return rows.filter((r) => canFor(actor, PERM, r)).map((r) => ({
    id: r.id, name: r.name, number: r.number, department: r.department, title: r.title,
    shift: r.shift, shift_from: r.shift_from, next_shift: r.next_shift, next_shift_from: r.next_shift_from,
    weekly_off: r.weekly_off, next_weekly_off: r.next_weekly_off, next_weekly_off_from: r.next_weekly_off_from,
    capture: r.capture, penalty: r.penalty, overtime: r.overtime,
  }));
}

export type AssignInput = { employeeIds: string[]; kind: "shift" | "weekly_off" | "capture" | "penalty" | "overtime"; policyId: string | null; from: ISODate };

/**
 * Bulk assignment. Shifts and weekly offs are dated: the current period ends the day before `from`, anything
 * scheduled on or after `from` is replaced, and the new one runs open-ended (so the no-overlap constraint holds).
 * Capture and penalty policies apply straight away. Past days in the range are re-processed.
 */
export async function assign(tx: Tx, actor: Actor, input: AssignInput) {
  const ids = [...new Set(input.employeeIds)];
  if (!ids.length) throw new AppError("invalid", "Choose at least one person.");
  const people = await tx<(Placement & { id: string; name: string })[]>`
    select id, display_name as name, department_id, location_id, legal_entity_id, business_unit_id from employees where id = any(${ids}::uuid[]) and status <> 'relieved'`;
  if (people.length !== ids.length) throw new AppError("not_found", "Some of these people are no longer active.");
  const outside = people.filter((p) => !canFor(actor, PERM, p));
  if (outside.length) throw new AppError("forbidden", `You can't change time settings for ${outside[0].name}${outside.length > 1 ? ` and ${outside.length - 1} more` : ""}.`);
  const today = todayIn();
  if (input.kind === "shift" || input.kind === "weekly_off") {
    if (!input.policyId) throw new AppError("invalid", input.kind === "shift" ? "Choose a shift." : "Choose a weekly-off policy.");
    if (input.from < addDaysISO(today, -31) || input.from > addDaysISO(today, 366)) throw new AppError("invalid", "The effective date can be up to a month back or a year ahead.", "from");
    const table = input.kind === "shift" ? "shift_assignments" : "weekly_off_assignments";
    const col = input.kind === "shift" ? "shift_id" : "policy_id";
    const [exists] = input.kind === "shift"
      ? await tx`select 1 from shifts where id = ${input.policyId}`
      : await tx`select 1 from weekly_off_policies where id = ${input.policyId}`;
    if (!exists) throw new AppError("not_found", "That option no longer exists.");
    await tx`delete from ${tx(table)} where employee_id = any(${ids}::uuid[]) and lower(period) >= ${input.from}::date`;
    await tx`update ${tx(table)} set period = daterange(lower(period), ${input.from}::date) where employee_id = any(${ids}::uuid[]) and period @> ${input.from}::date`;
    for (const id of ids) await tx`insert into ${tx(table)} (tenant_id, employee_id, ${tx(col)}, period) values (${actor.tenant.id}, ${id}, ${input.policyId}, daterange(${input.from}::date, null))`;
  } else {
    if (input.policyId) {
      const [exists] = input.kind === "capture"
        ? await tx`select 1 from capture_policies where id = ${input.policyId}`
        : input.kind === "overtime" ? await tx`select 1 from overtime_policies where id = ${input.policyId}`
        : await tx`select 1 from penalization_policies where id = ${input.policyId}`;
      if (!exists) throw new AppError("not_found", "That option no longer exists.");
    }
    const col = input.kind === "capture" ? "capture_policy_id" : input.kind === "overtime" ? "overtime_policy_id" : "penalization_policy_id";
    await tx`update employees set ${tx(col)} = ${input.policyId} where id = any(${ids}::uuid[])`;
  }
  await audit(tx, actor, "attendance_assignment", ids[0], `assign.${input.kind}`, { employeeIds: ids, policyId: input.policyId, from: input.from });
  // re-process days the change reaches (capture rules only affect new punches; big batches are left to the nightly run)
  const from = input.kind === "penalty" || input.kind === "overtime" ? today.slice(0, 8) + "01" : input.from;
  if (input.kind !== "capture" && from <= today && ids.length <= 100) {
    for (const id of ids) await reprocessFrom(tx, actor.tenant.id, id, from, today);
  }
  return { updated: ids.length };
}
