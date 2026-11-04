"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import * as compOff from "@/server/modules/leave/comp-off";
import { chooseFloater } from "@/server/modules/leave/holidays";
import { timeline } from "@/server/modules/approvals/service";
import { hasAnyLeaveAdmin } from "@/server/modules/leave/access";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.uuid();

export async function requestCompOffAction(input: { dates: string[]; note?: string }) {
  const p = z.object({ dates: z.array(isoDate).min(1, "Pick the days you worked.").max(31), note: z.string().max(1000).optional() }).safeParse(input);
  if (!p.success) return { ok: false as const, error: p.error.issues[0].message };
  return runAction((tx, actor) => compOff.requestCompOff(tx, actor, p.data));
}

export async function cancelCompOffAction(id: string) {
  if (!uuid.safeParse(id).success) return { ok: false as const, error: "Comp-off request not found." };
  return runAction((tx, actor) => compOff.cancelCompOff(tx, actor, id));
}

export async function chooseFloaterAction(holidayId: string, on: boolean) {
  if (!uuid.safeParse(holidayId).success) return { ok: false as const, error: "Holiday not found." };
  return runAction((tx, actor) => chooseFloater(tx, actor, holidayId, !!on));
}

/** Approver's drawer in the inbox: the claim, each day's type for the person, clock-ins, and the approval chain. */
export async function compOffDetailAction(id: string) {
  if (!uuid.safeParse(id).success) return { ok: false as const, error: "Comp-off request not found." };
  return runAction(async (tx, actor) => {
    const d = await compOff.compOffDetail(tx, id);
    if (!d) return null;
    const [approver] = await tx`select 1 from approval_steps s join approval_requests r on r.id = s.request_id
                                where r.entity_type = 'comp_off' and r.entity_id = ${id} and s.approver_employee_id = ${actor.employeeId}`;
    if (!approver && d.employee_id !== actor.employeeId && !hasAnyLeaveAdmin(actor)) return null;
    const steps = await timeline(tx, "comp_off", id);
    return { id: d.id, employee: d.employee, days: d.days, note: d.note, status: d.status, dates: d.dates,
      steps: steps.map((s) => ({ ...s, acted_at: s.acted_at?.toISOString() ?? null })) };
  }, { refresh: false });
}

// ---------------------------------------------------------------- time3: own request chain, applying on behalf, policy
import { withTenant } from "@/server/db";
import { requireActor } from "@/server/auth/session";
import { leaveMarks } from "@/server/page-data";
import * as leave from "@/server/modules/leave/service";
import { canAdminLeaveFor } from "@/server/modules/leave/access";

const leaveInput = z.object({
  leaveTypeId: uuid, from: isoDate, to: isoDate,
  fromPart: z.enum(["full", "first", "second"]), toPart: z.enum(["full", "first", "second"]),
  note: z.string().max(1000).optional(), notify: z.array(uuid).max(20).optional(),
});

/** The person's own request with its full approval chain. Also readable by its approvers and by leave admins for the person. */
export async function myLeaveRequestDetailAction(requestId: string) {
  if (!uuid.safeParse(requestId).success) return null;
  const actor = await requireActor();
  return withTenant(actor.tenant.id, async (tx) => {
    const r = await leave.requestDetail(tx, requestId);
    if (!r) return null;
    if (r.employee_id !== actor.employeeId) {
      const [approver] = await tx`select 1 from approval_steps s join approval_requests q on q.id = s.request_id where q.entity_type = 'leave' and q.entity_id = ${requestId} and s.approver_employee_id = ${actor.employeeId}`;
      const [p] = await tx<{ department_id: string | null; location_id: string | null; legal_entity_id: string | null; business_unit_id: string | null }[]>`select department_id, location_id, legal_entity_id, business_unit_id from employees where id = ${r.employee_id}`;
      if (!approver && !(p && canAdminLeaveFor(actor, p))) return null;
    }
    const steps = await timeline(tx, "leave", requestId);
    return {
      id: r.id, type: r.type, color: r.color, from: r.from_date, to: r.to_date, days: Number(r.days), status: r.status, note: r.note,
      appliedBy: r.applied_by_name, grantEvent: r.grant_event, createdAt: r.created_at.toISOString(), employee: r.employee,
      steps: steps.map((s) => ({ level: s.level, status: s.status, comment: s.comment, actedAt: s.acted_at?.toISOString() ?? null, approver: s.approver, title: s.title })),
    };
  });
}

/** What the apply form needs for someone else: their leave types with balances and their calendar marks. */
export async function leaveFormForAction(employeeId: string) {
  if (!uuid.safeParse(employeeId).success) return { ok: false as const, error: "Unknown person." };
  return runAction(async (tx, actor) => {
    const e = await leave.assertCanApplyFor(tx, actor, employeeId);
    const [bal, marks] = await Promise.all([leave.balances(tx, employeeId), leaveMarks(tx, employeeId)]);
    return { name: e.name, marks, types: bal.map((b) => ({ id: b.id, name: b.name, available: Number.isFinite(b.available) ? b.available : null, allowHalfDay: !!b.rules.allowHalfDay })) };
  }, { refresh: false });
}

export async function previewLeaveForAction(employeeId: string, input: z.input<typeof leaveInput>) {
  const parsed = leaveInput.safeParse(input);
  if (!parsed.success || !uuid.safeParse(employeeId).success) return { ok: false as const, error: "Pick a leave type and dates." };
  return runAction(async (tx, actor) => {
    await leave.assertCanApplyFor(tx, actor, employeeId);
    const p = await leave.preview(tx, employeeId, parsed.data);
    return { days: p.days, violations: p.violations, breakdown: p.breakdown, available: p.type.available };
  }, { refresh: false });
}

/** HR or a manager applies for someone (a note is required; the person is told; the chain runs). */
export async function applyLeaveForAction(employeeId: string, input: z.input<typeof leaveInput>) {
  const parsed = leaveInput.safeParse(input);
  if (!parsed.success || !uuid.safeParse(employeeId).success) return { ok: false as const, error: "Pick a leave type and dates." };
  return runAction((tx, actor) => leave.applyOnBehalf(tx, actor, employeeId, parsed.data));
}
