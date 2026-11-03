"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import { AppError } from "@/server/db";
import { decide } from "@/server/modules/approvals/service";
import * as psa from "@/server/modules/psa/service";
import { BILLING_MODELS, PROJECT_STATUSES, type InvoiceStatus } from "@/server/modules/psa/rules";

const uuid = z.uuid();
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();

// ---------- approvals ----------
export async function decideTimesheetAction(stepId: string, decision: "approved" | "rejected", comment?: string) {
  if (!uuid.safeParse(stepId).success || !["approved", "rejected"].includes(decision)) return bad("This request can't be found.");
  return runAction((tx, actor) => decide(tx, actor, stepId, decision, comment?.slice(0, 1000)));
}

export async function timesheetDetailAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Timesheet not found.");
  return runAction(async (tx, actor) => {
    const d = await psa.timesheetDetail(tx, actor, id);
    if (!d) throw new AppError("not_found", "This timesheet doesn't exist or isn't shared with you.");
    return d;
  }, { refresh: false });
}

export async function reopenTimesheetAction(id: string, reason: string) {
  if (!uuid.safeParse(id).success) return bad("Timesheet not found.");
  return runAction((tx, actor) => psa.reopenTimesheet(tx, actor, id, reason ?? ""));
}

// ---------- clients ----------
const clientSchema = z.object({
  name: z.string().max(200), gstin: z.string().max(20).nullable(), currency: z.string().length(3),
  address: z.object({ line1: z.string().max(200).optional(), line2: z.string().max(200).optional(), city: z.string().max(100).optional(), state: z.string().max(100).optional(), pincode: z.string().max(12).optional(), email: z.string().max(200).optional() }),
});
export async function saveClientAction(id: string | null, input: unknown) {
  if (id !== null && !uuid.safeParse(id).success) return bad("Client not found.");
  const p = clientSchema.safeParse(input);
  if (!p.success) return bad("Check the client details.", "name");
  return runAction((tx, actor) => psa.saveClient(tx, actor, id, p.data));
}
export async function deleteClientAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Client not found.");
  return runAction((tx, actor) => psa.deleteClient(tx, actor, id));
}

// ---------- projects ----------
const projectSchema = z.object({
  name: z.string().max(200), code: z.string().max(20), clientId: uuid.nullable(), billingModel: z.enum(BILLING_MODELS), retainerPaise: z.number().int().nullable(), currency: z.string().length(3),
  startDate: date, endDate: date, description: z.string().max(4000).nullable(), approverIds: z.array(uuid).max(10), budgetMinutes: z.number().int().nullable(),
});
export async function saveProjectAction(id: string | null, input: unknown) {
  if (id !== null && !uuid.safeParse(id).success) return bad("Project not found.");
  const p = projectSchema.safeParse(input);
  if (!p.success) return bad("Check the project details.", p.error.issues[0]?.path.join(".") || "name");
  return runAction((tx, actor) => psa.saveProject(tx, actor, id, p.data));
}
export async function setProjectStatusAction(id: string, status: string) {
  if (!uuid.safeParse(id).success || !(PROJECT_STATUSES as readonly string[]).includes(status)) return bad("Project not found.");
  return runAction((tx, actor) => psa.setProjectStatus(tx, actor, id, status as (typeof PROJECT_STATUSES)[number]));
}
export async function saveMemberAction(projectId: string, input: { employeeId: string; role: string | null; billRatePaise: number | null; allocationPct: number | null }) {
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(input?.employeeId).success) return bad("Pick a person.", "employeeId");
  return runAction((tx, actor) => psa.saveMember(tx, actor, projectId, { employeeId: input.employeeId, role: input.role, billRatePaise: input.billRatePaise, allocationPct: input.allocationPct }));
}
export async function removeMemberAction(projectId: string, employeeId: string) {
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(employeeId).success) return bad("Not found.");
  return runAction((tx, actor) => psa.removeMember(tx, actor, projectId, employeeId));
}
const taskSchema = z.object({ name: z.string().max(200), isBillable: z.boolean(), phase: z.string().max(80).nullable(), startDate: date, endDate: date });
export async function saveTaskAction(projectId: string, id: string | null, input: unknown) {
  if (!uuid.safeParse(projectId).success || (id !== null && !uuid.safeParse(id).success)) return bad("Project not found.");
  const p = taskSchema.safeParse(input);
  if (!p.success) return bad("Check the task details.", "name");
  return runAction((tx, actor) => psa.saveTask(tx, actor, projectId, id, p.data));
}
export async function deleteTaskAction(projectId: string, id: string) {
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(id).success) return bad("Task not found.");
  return runAction((tx, actor) => psa.deleteTask(tx, actor, projectId, id));
}
const milestoneSchema = z.object({ name: z.string().max(200), phase: z.string().max(80).nullable(), dueDate: date, amountPaise: z.number().int(), status: z.enum(["planned", "done"]) });
export async function saveMilestoneAction(projectId: string, id: string | null, input: unknown) {
  if (!uuid.safeParse(projectId).success || (id !== null && !uuid.safeParse(id).success)) return bad("Project not found.");
  const p = milestoneSchema.safeParse(input);
  if (!p.success) return bad("Check the milestone details.", "name");
  return runAction((tx, actor) => psa.saveMilestone(tx, actor, projectId, id, p.data));
}
export async function deleteMilestoneAction(projectId: string, id: string) {
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(id).success) return bad("Milestone not found.");
  return runAction((tx, actor) => psa.deleteMilestone(tx, actor, projectId, id));
}

// ---------- invoices ----------
const candidateSchema = z.object({ projectId: uuid, from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), taxRateBp: z.number().int().min(0).max(10000), milestoneIds: z.array(uuid).max(50) });
export async function invoiceCandidateAction(input: unknown) {
  const p = candidateSchema.safeParse(input);
  if (!p.success) return bad("Pick a project and a period.", "projectId");
  return runAction((tx, actor) => psa.invoiceCandidate(tx, actor, p.data.projectId, p.data.from, p.data.to, p.data.taxRateBp, p.data.milestoneIds), { refresh: false });
}
export async function createInvoiceAction(input: unknown) {
  const p = candidateSchema.extend({ notes: z.string().max(1000).nullable(), dueInDays: z.number().int().min(0).max(180) }).safeParse(input);
  if (!p.success) return bad("Pick a project and a period.", "projectId");
  return runAction((tx, actor) => psa.createInvoice(tx, actor, p.data));
}
export async function setInvoiceStatusAction(id: string, to: InvoiceStatus) {
  if (!uuid.safeParse(id).success || !["sent", "paid", "void"].includes(to)) return bad("Invoice not found.");
  return runAction((tx, actor) => psa.setInvoiceStatus(tx, actor, id, to));
}
export async function invoiceDetailAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Invoice not found.");
  return runAction(async (tx, actor) => {
    const d = await psa.invoiceDetail(tx, actor, id);
    if (!d) throw new AppError("not_found", "Invoice not found.");
    return { ...d, subtotal_paise: Number(d.subtotal_paise), tax_paise: Number(d.tax_paise), created_at: d.created_at.toISOString() };
  }, { refresh: false });
}
