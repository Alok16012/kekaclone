"use server";
import { headers } from "next/headers";
import { z } from "zod";
import { runAction } from "@/server/action";
import { withTenant } from "@/server/db";
import { requireActor, assertCan } from "@/server/auth/session";
import * as attendance from "@/server/modules/attendance/service";
import * as leave from "@/server/modules/leave/service";
import * as approvals from "@/server/modules/approvals/service";
import { createEmployee } from "@/server/modules/employees/service";
import * as profile from "@/server/modules/employees/profile";
import { isSection } from "@/server/modules/employees/fields";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const uuid = z.uuid();

export async function clockAction(expect: "in" | "out") {
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0] ?? null;
  return runAction((tx, actor) => attendance.punch(tx, actor, { ip, expect: z.enum(["in", "out"]).parse(expect) }));
}

const leaveInput = z.object({
  leaveTypeId: uuid, from: isoDate, to: isoDate,
  fromPart: z.enum(["full", "first", "second"]), toPart: z.enum(["full", "first", "second"]),
  note: z.string().max(1000).optional(), notify: z.array(uuid).max(20).optional(),
});

/** Live preview while the person picks dates: days (with sandwich), warnings and blocking problems. No write. */
export async function previewLeaveAction(input: z.input<typeof leaveInput>) {
  const parsed = leaveInput.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Pick a leave type and dates." };
  return runAction((tx, actor) => leave.preview(tx, actor.employeeId, parsed.data).then((p) => ({ days: p.days, violations: p.violations, breakdown: p.breakdown, available: p.type.available })), { refresh: false });
}

export async function applyLeaveAction(input: z.input<typeof leaveInput>) {
  const parsed = leaveInput.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Pick a leave type and dates." };
  return runAction((tx, actor) => leave.apply(tx, actor, parsed.data));
}

export async function cancelLeaveAction(id: string) {
  return runAction((tx, actor) => leave.cancel(tx, actor, uuid.parse(id)));
}

export async function decideAction(stepId: string, decision: "approved" | "rejected", comment?: string) {
  return runAction((tx, actor) => approvals.decide(tx, actor, uuid.parse(stepId), z.enum(["approved", "rejected"]).parse(decision), comment?.slice(0, 1000)));
}

export async function leaveRequestDetailAction(requestId: string) {
  const actor = await requireActor();
  return withTenant(actor.tenant.id, async (tx) => {
    const r = await leave.requestDetail(tx, uuid.parse(requestId));
    if (!r) return null;
    const [steps, bal] = await Promise.all([approvals.timeline(tx, "leave", r.id), leave.balances(tx, r.employee_id, r.from_date)]);
    return { request: r, steps: steps.map((s) => ({ ...s, acted_at: s.acted_at?.toISOString() ?? null })),
      balance: bal.find((b) => b.name === r.type) ? { available: Number.isFinite(bal.find((b) => b.name === r.type)!.available) ? bal.find((b) => b.name === r.type)!.available : null } : null };
  });
}

const employeeInput = z.object({
  firstName: z.string().trim().min(1, "Enter a first name").max(60),
  lastName: z.string().trim().max(60).optional(),
  workEmail: z.email("Enter a valid work email"),
  mobile: z.string().trim().max(20).optional(),
  employeeNumber: z.string().trim().max(30).optional(),
  joiningDate: isoDate,
  gender: z.enum(["male", "female", "non_binary", "undisclosed"]).optional(),
  departmentId: uuid.optional(), designationId: uuid.optional(), locationId: uuid.optional(), managerId: uuid.optional(),
});

export async function createEmployeeAction(input: z.input<typeof employeeInput>) {
  const parsed = employeeInput.safeParse(input);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { ok: false as const, error: i.message, field: String(i.path[0]) };
  }
  return runAction(async (tx, actor) => {
    assertCan(actor, "employees.write");
    return createEmployee(tx, actor.tenant.id, parsed.data, actor.userId);
  });
}

export async function markNotificationsReadAction() {
  return runAction((tx, actor) => tx`update notifications set read_at = now() where user_id = ${actor.userId} and read_at is null`.then(() => undefined));
}

// ---------- M1: profile ----------

export async function updateProfileSectionAction(employeeId: string, section: string, values: unknown) {
  if (!isSection(section)) return { ok: false as const, error: "Unknown section." };
  return runAction((tx, actor) => profile.updateSection(tx, actor, uuid.parse(employeeId), section, values));
}

const jobChangeInput = z.object({
  kind: z.enum(["transfer", "promotion", "manager_change", "designation_change", "other"]),
  effectiveDate: isoDate,
  changes: z.partialRecord(z.enum(profile.JOB_FIELDS), z.string().nullable()),
  note: z.string().max(500).optional(),
});

export async function changeJobAction(employeeId: string, input: z.input<typeof jobChangeInput>) {
  const parsed = jobChangeInput.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Check the fields and the effective date." };
  return runAction((tx, actor) => profile.changeJob(tx, actor, uuid.parse(employeeId), parsed.data));
}

export async function cancelJobChangeAction(id: string) {
  return runAction((tx, actor) => profile.cancelJobChange(tx, actor, uuid.parse(id)));
}

export async function setProbationAction(employeeId: string, input: { action: "confirm" | "extend" | "start"; date: string; note?: string }) {
  const parsed = z.object({ action: z.enum(["confirm", "extend", "start"]), date: isoDate, note: z.string().max(500).optional() }).safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Pick a valid date." };
  return runAction((tx, actor) => profile.setProbation(tx, actor, uuid.parse(employeeId), parsed.data));
}

export async function profileChangeDetailAction(requestId: string) {
  const actor = await requireActor();
  return withTenant(actor.tenant.id, async (tx) => {
    const [r] = await tx<{ id: string; section: string; changes: Record<string, { old: unknown; new: unknown }>; status: string; employee_id: string }[]>`
      select id, section, changes, status, employee_id from profile_change_requests where id = ${uuid.parse(requestId)}`;
    if (!r) return null;
    const steps = await approvals.timeline(tx, "profile_change", r.id);
    return { ...r, steps: steps.map((s) => ({ ...s, acted_at: s.acted_at?.toISOString() ?? null })) };
  });
}
