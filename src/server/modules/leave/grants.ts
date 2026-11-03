import "server-only";
import { z } from "zod";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { todayIn, type ISODate } from "@/lib/dates";
import { notifyEmployee } from "@/server/modules/approvals/service";
import { round2, type GrantLike } from "./accrual-rules";
import { canAdminLeaveFor, hasAnyLeaveAdmin } from "./access";
import { cycleStartFor } from "./effects";

/**
 * Event-based leave grants (marriage, bereavement, paternity …): HR grants N days of an 'incident' leave type for one
 * event, valid between two dates. The credit lands in the ledger at once; a request of that type inside the window
 * draws on the grant (leave_requests.grant_id); whatever is unused after the window lapses in the nightly run.
 */

const audit = (tx: Tx, actor: Actor, id: string, action: string, diff?: unknown) =>
  tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff)
     values (${actor.tenant.id}, ${actor.userId}, 'leave_grant', ${id}, ${action}, ${diff === undefined ? null : tx.json(diff as never)})`;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date");
const grantInput = z.object({
  employeeId: z.uuid(), leaveTypeId: z.uuid(),
  event: z.string().trim().min(2, "Say what the leave is for, like Marriage or Bereavement").max(80),
  days: z.number().refine((n) => n > 0 && n <= 365 && Math.abs(Math.round(n * 2) - n * 2) < 1e-6, "Enter whole or half days, like 5 or 2.5"),
  validFrom: isoDate, validTo: isoDate,
  note: z.string().trim().max(300).optional().nullable(),
});

export type GrantRow = {
  id: string; employee_id: string; employee: string; leave_type_id: string; type: string; color: string; event: string; days: number; used: number;
  valid_from: string; valid_to: string; note: string | null; status: "active" | "cancelled" | "lapsed"; granted_by: string | null; created_at: string;
};

const ROW = (tx: Tx) => tx`
  g.id, g.employee_id, e.display_name as employee, g.leave_type_id, t.name as type, t.color, g.event, g.days, g.valid_from::text, g.valid_to::text, g.note, g.status, g.created_at,
  u.email::text as granted_by,
  coalesce((select sum(q.days) from leave_requests q where q.grant_id = g.id and q.status in ('pending','approved')), 0) as used`;

const shape = (r: Record<string, unknown>): GrantRow => ({
  ...(r as Omit<GrantRow, "days" | "used" | "created_at">), days: Number(r.days), used: Number(r.used), created_at: (r.created_at as Date).toISOString(),
});

/** Grants HR may see: everyone in their scope (or one person). */
export async function listGrants(tx: Tx, actor: Actor, employeeId?: string): Promise<GrantRow[]> {
  if (!hasAnyLeaveAdmin(actor) && employeeId !== actor.employeeId) throw new AppError("forbidden", "You don't have access to leave grants.");
  const rows = await tx<(Record<string, unknown> & { department_id: string | null; location_id: string | null; legal_entity_id: string | null; business_unit_id: string | null })[]>`
    select ${ROW(tx)}, e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id
    from leave_grants g join employees e on e.id = g.employee_id join leave_types t on t.id = g.leave_type_id left join users u on u.id = g.granted_by
    where (${employeeId ?? null}::uuid is null or g.employee_id = ${employeeId ?? null}::uuid)
    order by g.status = 'active' desc, g.valid_to desc, g.created_at desc limit 500`;
  return rows.filter((r) => r.employee_id === actor.employeeId || canAdminLeaveFor(actor, r)).map(shape);
}

/** The person's own grants, for the Leave page. */
export async function myGrants(tx: Tx, employeeId: string): Promise<GrantRow[]> {
  const rows = await tx<Record<string, unknown>[]>`
    select ${ROW(tx)} from leave_grants g join employees e on e.id = g.employee_id join leave_types t on t.id = g.leave_type_id left join users u on u.id = g.granted_by
    where g.employee_id = ${employeeId} order by g.status = 'active' desc, g.valid_to desc limit 50`;
  return rows.map(shape);
}

/** Grants a request of this type may draw on today: active, with days left. */
export async function activeGrants(tx: Tx, employeeId: string, leaveTypeId: string): Promise<GrantLike[]> {
  const rows = await tx<{ id: string; days: string; used: string; valid_from: string; valid_to: string }[]>`
    select g.id, g.days, g.valid_from::text, g.valid_to::text,
      coalesce((select sum(q.days) from leave_requests q where q.grant_id = g.id and q.status in ('pending','approved')), 0) as used
    from leave_grants g where g.employee_id = ${employeeId} and g.leave_type_id = ${leaveTypeId} and g.status = 'active' order by g.valid_to`;
  return rows.map((r) => ({ id: r.id, days: Number(r.days), used: Number(r.used), validFrom: r.valid_from, validTo: r.valid_to }));
}

/** HR grants days for an event. The credit is posted to the ledger at once; the person is told. */
export async function grantLeave(tx: Tx, actor: Actor, raw: unknown) {
  const p = grantInput.safeParse(raw);
  if (!p.success) throw new AppError("invalid", p.error.issues[0].message, String(p.error.issues[0].path[0] ?? ""));
  const v = p.data;
  if (v.validTo < v.validFrom) throw new AppError("invalid", "The grant can't end before it starts.", "validTo");
  if (v.validTo < todayIn()) throw new AppError("invalid", "The grant's last day has already passed.", "validTo");
  const [e] = await tx<{ id: string; name: string; department_id: string | null; location_id: string | null; legal_entity_id: string | null; business_unit_id: string | null }[]>`
    select id, display_name as name, department_id, location_id, legal_entity_id, business_unit_id from employees where id = ${v.employeeId} and status <> 'relieved'`;
  if (!e) throw new AppError("not_found", "Person not found.");
  if (!canAdminLeaveFor(actor, e)) throw new AppError("forbidden", "You can't grant leave to this person.");
  if (e.id === actor.employeeId) throw new AppError("forbidden", "You can't grant leave to yourself. Ask another leave admin.");
  const [t] = await tx<{ name: string; kind: string; in_plan: boolean }[]>`
    select t.name, t.kind, exists (select 1 from employees x join leave_plan_rules r on r.leave_plan_id = x.leave_plan_id where x.id = ${e.id} and r.leave_type_id = t.id) as in_plan
    from leave_types t where t.id = ${v.leaveTypeId}`;
  if (!t) throw new AppError("not_found", "Leave type not found.");
  if (t.kind !== "incident") throw new AppError("invalid", `${t.name} isn't an event-based leave type. Grants are for types like marriage or bereavement leave.`, "leaveTypeId");
  if (!t.in_plan) throw new AppError("invalid", `${t.name} isn't in ${e.name}'s leave plan. Add it to the plan first.`, "leaveTypeId");
  const [g] = await tx<{ id: string }[]>`
    insert into leave_grants (tenant_id, employee_id, leave_type_id, event, days, valid_from, valid_to, note, granted_by)
    values (${actor.tenant.id}, ${e.id}, ${v.leaveTypeId}, ${v.event}, ${v.days}, ${v.validFrom}, ${v.validTo}, ${v.note || null}, ${actor.userId}) returning id`;
  const cycle = await cycleStartFor(tx, e.id, v.validFrom);
  await tx`insert into leave_ledger (tenant_id, employee_id, leave_type_id, cycle_start, entry_date, kind, amount, ref_type, ref_id, note, idempotency_key, created_by)
           values (${actor.tenant.id}, ${e.id}, ${v.leaveTypeId}, ${cycle}, ${todayIn()}, 'adjust', ${v.days}, 'leave_grant', ${g.id},
                   ${`${v.event}: ${v.days} ${v.days === 1 ? "day" : "days"}, use between ${v.validFrom} and ${v.validTo}`}, ${`grant:${g.id}`}, ${actor.userId})`;
  await audit(tx, actor, g.id, "create", { ...v, type: t.name });
  await notifyEmployee(tx, actor.tenant.id, e.id, "leave.adjusted", `${t.name} granted`,
    `${v.days} ${v.days === 1 ? "day" : "days"} for ${v.event}, to use between ${v.validFrom} and ${v.validTo}.`, "/me/leave");
  return { id: g.id };
}

/** Withdraws what's left of a grant. Days already requested stay with those requests. */
export async function cancelGrant(tx: Tx, actor: Actor, id: string) {
  const [g] = await tx<{ id: string; employee_id: string; leave_type_id: string; days: string; used: string; status: string; event: string; valid_from: string; department_id: string | null; location_id: string | null; legal_entity_id: string | null; business_unit_id: string | null }[]>`
    select g.id, g.employee_id, g.leave_type_id, g.days, g.status, g.event, g.valid_from::text, e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id,
      coalesce((select sum(q.days) from leave_requests q where q.grant_id = g.id and q.status in ('pending','approved')), 0) as used
    from leave_grants g join employees e on e.id = g.employee_id where g.id = ${id} for update of g`;
  if (!g) throw new AppError("not_found", "Grant not found.");
  if (!canAdminLeaveFor(actor, g)) throw new AppError("forbidden", "You can't change this grant.");
  if (g.status !== "active") throw new AppError("invalid", "This grant is already closed.");
  const left = round2(Number(g.days) - Number(g.used));
  await tx`update leave_grants set status = 'cancelled', updated_at = now() where id = ${id}`;
  if (left > 0) {
    const cycle = await cycleStartFor(tx, g.employee_id, g.valid_from);
    await tx`insert into leave_ledger (tenant_id, employee_id, leave_type_id, cycle_start, entry_date, kind, amount, ref_type, ref_id, note, idempotency_key, created_by)
             values (${actor.tenant.id}, ${g.employee_id}, ${g.leave_type_id}, ${cycle}, ${todayIn()}, 'adjust', ${-left}, 'leave_grant', ${id}, ${`${g.event}: grant withdrawn`}, ${`grant:${id}:cancel`}, ${actor.userId})
             on conflict (tenant_id, idempotency_key) do nothing`;
  }
  await audit(tx, actor, id, "cancel", { left });
  return { left };
}

/** Nightly: grants whose window has passed lose what's left. Idempotent per grant. */
export async function lapseExpiredGrants(tx: Tx, tenantId: string, asOf: ISODate) {
  const due = await tx<{ id: string; employee_id: string; leave_type_id: string; days: string; used: string; event: string; valid_from: string; valid_to: string }[]>`
    select g.id, g.employee_id, g.leave_type_id, g.days, g.event, g.valid_from::text, g.valid_to::text,
      coalesce((select sum(q.days) from leave_requests q where q.grant_id = g.id and q.status in ('pending','approved')), 0) as used
    from leave_grants g where g.status = 'active' and g.valid_to < ${asOf} for update of g`;
  let lapsed = 0, days = 0;
  for (const g of due) {
    const left = round2(Number(g.days) - Number(g.used));
    await tx`update leave_grants set status = 'lapsed', updated_at = now() where id = ${g.id}`;
    if (left > 0) {
      const cycle = await cycleStartFor(tx, g.employee_id, g.valid_from);
      const ins = await tx`insert into leave_ledger (tenant_id, employee_id, leave_type_id, cycle_start, entry_date, kind, amount, ref_type, ref_id, note, idempotency_key)
               values (${tenantId}, ${g.employee_id}, ${g.leave_type_id}, ${cycle}, ${asOf}, 'lapse', ${-left}, 'leave_grant', ${g.id}, ${`${g.event}: unused days lapsed after ${g.valid_to}`}, ${`grant:${g.id}:lapse`})
               on conflict (tenant_id, idempotency_key) do nothing returning id`;
      if (ins.length) { lapsed++; days = round2(days + left); }
    }
  }
  return { lapsed, days };
}
