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
