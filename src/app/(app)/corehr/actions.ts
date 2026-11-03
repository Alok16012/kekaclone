"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import * as people from "@/server/modules/corehr/people";
import * as sections from "@/server/modules/corehr/profile-sections";
import * as fields from "@/server/modules/corehr/custom-fields";
import * as life from "@/server/modules/corehr/lifecycle";
import * as appr from "@/server/modules/corehr/approvals-admin";
import { commitUpdate, previewUpdate } from "@/server/modules/corehr/bulk-update";
import { CONDITION_FIELDS, CUSTOM_FIELD_TYPES } from "@/server/modules/corehr/rules";

const uuid = z.uuid();
const isoDate = z.iso.date();
const bad = (e: z.ZodError) => ({ ok: false as const, error: e.issues[0]?.message ?? "Check the fields.", field: e.issues[0]?.path.map(String).join(".") });
const opt = uuid.nullable().optional();

// ---------- org chart ----------
export async function orgChildrenAction(managerId: string | null) {
  const id = managerId === null ? { success: true as const, data: null } : uuid.safeParse(managerId);
  if (!id.success) return { ok: false as const, error: "Unknown person." };
  return runAction((tx) => people.orgChildren(tx, id.data), { refresh: false });
}
export async function orgAllAction() {
  return runAction((tx) => people.orgAll(tx), { refresh: false });
}
export async function departmentMembersAction(departmentId: string | null) {
  const id = departmentId === null ? { success: true as const, data: null } : uuid.safeParse(departmentId);
  if (!id.success) return { ok: false as const, error: "Unknown department." };
  return runAction((tx) => people.departmentMembers(tx, id.data), { refresh: false });
}

// ---------- add employee wizard ----------
const wizardInput = z.object({
  firstName: z.string().trim().min(1, "Enter a first name").max(60), middleName: z.string().trim().max(60).optional(), lastName: z.string().trim().max(60).optional(),
  workEmail: z.email("Enter a valid work email"), personalEmail: z.email("Enter a valid personal email").optional().or(z.literal("").transform(() => undefined)),
  mobile: z.string().trim().max(20).optional(), employeeNumber: z.string().trim().max(30).optional(), gender: z.enum(["male", "female", "non_binary", "undisclosed"]).optional(),
  dob: isoDate.optional(), joiningDate: isoDate,
  departmentId: opt, designationId: opt, locationId: opt, legalEntityId: opt, businessUnitId: opt, bandId: opt, managerId: opt, l2ManagerId: opt, dottedManagerId: opt,
  workerType: z.enum(["permanent", "contract", "intern", "consultant"]).optional(), timeType: z.enum(["full_time", "part_time"]).optional(),
  probationPolicyId: opt, noticePolicyId: opt, leavePlanId: opt, holidayListId: opt, shiftId: opt, weeklyOffId: opt, capturePolicyId: opt, penalizationPolicyId: opt, payGroupId: opt,
  custom: z.record(z.string().max(60), z.unknown()).optional(),
  compensation: z.object({ structureId: uuid, ctcPaise: z.number().int().positive("Enter the annual CTC") }).nullable().optional(),
  sendInvite: z.boolean().optional(),
});
export async function addEmployeeAction(input: z.input<typeof wizardInput>) {
  const p = wizardInput.safeParse(input);
  if (!p.success) return bad(p.error);
  return runAction((tx, actor) => people.addEmployee(tx, actor, p.data));
}

// ---------- rehire ----------
const rehireInput = z.object({
  mode: z.enum(["reactivate", "new_record"]), joiningDate: isoDate, workEmail: z.email("Enter a valid work email").nullable().optional(), employeeNumber: z.string().trim().max(30).nullable().optional(),
  departmentId: opt, designationId: opt, locationId: opt, managerId: opt, overrideNotRehirable: z.boolean().optional(), sendInvite: z.boolean().optional(),
});
export async function rehireAction(employeeId: string, input: z.input<typeof rehireInput>) {
  const p = rehireInput.safeParse(input);
  if (!p.success) return bad(p.error);
  return runAction((tx, actor) => people.rehire(tx, actor, uuid.parse(employeeId), p.data));
}

// ---------- profile sections ----------
export async function saveSectionRowAction(employeeId: string, kind: string, id: string | null, values: unknown) {
  const k = z.enum(["relation", "education", "experience"]).safeParse(kind);
  if (!k.success) return { ok: false as const, error: "Unknown section." };
  return runAction((tx, actor) => sections.saveSectionRow(tx, actor, uuid.parse(employeeId), k.data, id ? uuid.parse(id) : null, values));
}
export async function deleteSectionRowAction(employeeId: string, kind: string, id: string) {
  const k = z.enum(["relation", "education", "experience"]).safeParse(kind);
  if (!k.success) return { ok: false as const, error: "Unknown section." };
  return runAction((tx, actor) => sections.deleteSectionRow(tx, actor, uuid.parse(employeeId), k.data, uuid.parse(id)));
}
export async function saveIdentityAction(employeeId: string, values: unknown) {
  return runAction((tx, actor) => sections.saveIdentity(tx, actor, uuid.parse(employeeId), values));
}
export async function verifyIdentityAction(id: string, verified: boolean) {
  return runAction((tx, actor) => sections.verifyIdentity(tx, actor, uuid.parse(id), !!verified));
}
export async function revealIdentityAction(id: string) {
  return runAction((tx, actor) => sections.revealIdentity(tx, actor, uuid.parse(id)), { refresh: false });
}
export async function deleteIdentityAction(id: string) {
  return runAction((tx, actor) => sections.deleteIdentity(tx, actor, uuid.parse(id)));
}
export async function saveCustomFieldsAction(employeeId: string, values: Record<string, unknown>) {
  const p = z.record(z.string().max(60), z.unknown()).safeParse(values);
  if (!p.success) return { ok: false as const, error: "Check the fields." };
  return runAction((tx, actor) => fields.savePersonFields(tx, actor, uuid.parse(employeeId), p.data));
}
export async function timeTabAction(employeeId: string, month: string) {
  if (!/^\d{4}-\d{2}-01$/.test(month)) return { ok: false as const, error: "Pick a month." };
  return runAction((tx, actor) => people.timeTab(tx, actor, uuid.parse(employeeId), month), { refresh: false });
}

// ---------- custom field definitions ----------
const defInput = z.object({
  label: z.string().max(200), section: z.string().max(200), type: z.enum(CUSTOM_FIELD_TYPES), options: z.array(z.string().max(200)).max(60).nullable().optional(),
  required: z.boolean(), viewRoles: z.array(z.string().max(20)).max(5), editRoles: z.array(z.string().max(20)).max(5), position: z.number().int().optional(),
});
export async function saveFieldDefAction(id: string | null, input: z.input<typeof defInput>) {
  const p = defInput.safeParse(input);
  if (!p.success) return bad(p.error);
  return runAction((tx, actor) => fields.saveDef(tx, actor, id ? uuid.parse(id) : null, p.data));
}
export async function setFieldStatusAction(id: string, status: string) {
  const s = z.enum(["published", "archived", "draft"]).safeParse(status);
  if (!s.success) return { ok: false as const, error: "Unknown status." };
  return runAction((tx, actor) => fields.setDefStatus(tx, actor, uuid.parse(id), s.data));
}
export async function deleteFieldDefAction(id: string) {
  return runAction((tx, actor) => fields.deleteDef(tx, actor, uuid.parse(id)));
}

// ---------- groups + probation ----------
export async function saveGroupTypeAction(id: string | null, name: string) {
  return runAction((tx, actor) => life.saveGroupType(tx, actor, id ? uuid.parse(id) : null, String(name).slice(0, 200)));
}
export async function deleteGroupTypeAction(id: string) {
  return runAction((tx, actor) => life.deleteGroupType(tx, actor, uuid.parse(id)));
}
export async function saveGroupAction(id: string | null, input: { typeId: string; name: string }) {
  const p = z.object({ typeId: uuid, name: z.string().max(200) }).safeParse(input);
  if (!p.success) return bad(p.error);
  return runAction((tx, actor) => life.saveGroup(tx, actor, id ? uuid.parse(id) : null, p.data));
}
export async function deleteGroupAction(id: string) {
  return runAction((tx, actor) => life.deleteGroup(tx, actor, uuid.parse(id)));
}
export async function groupMembersAction(id: string) {
  return runAction((tx) => life.groupMembers(tx, uuid.parse(id)), { refresh: false });
}
export async function setGroupMembersAction(id: string, employeeIds: string[]) {
  const p = z.array(uuid).max(5000).safeParse(employeeIds);
  if (!p.success) return { ok: false as const, error: "Choose people from the list." };
  return runAction((tx, actor) => life.setGroupMembers(tx, actor, uuid.parse(id), p.data));
}
export async function saveProbationPolicyAction(id: string | null, input: { name: string; durationDays: number; autoConfirm: boolean }) {
  const p = z.object({ name: z.string().max(200), durationDays: z.number().int(), autoConfirm: z.boolean() }).safeParse(input);
  if (!p.success) return bad(p.error);
  return runAction((tx, actor) => life.saveProbationPolicy(tx, actor, id ? uuid.parse(id) : null, p.data));
}
export async function deleteProbationPolicyAction(id: string) {
  return runAction((tx, actor) => life.deleteProbationPolicy(tx, actor, uuid.parse(id)));
}
export async function bulkProbationAction(input: { employeeIds: string[]; action: "confirm" | "extend"; date?: string; extendDays?: number; note?: string }) {
  const p = z.object({ employeeIds: z.array(uuid).min(1, "Choose at least one person").max(500), action: z.enum(["confirm", "extend"]), date: isoDate.optional(), extendDays: z.number().int().optional(), note: z.string().max(500).optional() }).safeParse(input);
  if (!p.success) return bad(p.error);
  return runAction((tx, actor) => life.bulkProbation(tx, actor, p.data));
}

// ---------- approvals ----------
const level = z.object({ approver: z.enum(["manager", "l2_manager", "role", "employee"]), role: z.string().max(60).optional(), id: uuid.optional() });
const workflowInput = z.object({
  entityType: z.string().max(40), name: z.string().max(200),
  conditions: z.array(z.object({ field: z.enum(CONDITION_FIELDS), values: z.array(z.string().max(40)).max(200) })).max(6),
  levels: z.array(level).max(6), autoApproveAfterDays: z.number().int().nullable(),
  escalation: z.object({ afterDays: z.number().int(), to: level }).nullable(), priority: z.number().int(), isActive: z.boolean(),
});
export async function saveWorkflowAction(id: string | null, input: z.input<typeof workflowInput>) {
  const p = workflowInput.safeParse(input);
  if (!p.success) return bad(p.error);
  return runAction((tx, actor) => appr.saveWorkflow(tx, actor, id ? uuid.parse(id) : null, p.data));
}
export async function deleteWorkflowAction(id: string) {
  return runAction((tx, actor) => appr.deleteWorkflow(tx, actor, uuid.parse(id)));
}
export async function saveDelegationAction(input: { delegatorId: string; delegateId: string; from: string; to: string | null; reason?: string | null }) {
  const p = z.object({ delegatorId: uuid, delegateId: z.uuid("Pick who approves for you"), from: isoDate, to: isoDate.nullable(), reason: z.string().max(300).nullable().optional() }).safeParse(input);
  if (!p.success) return bad(p.error);
  return runAction((tx, actor) => appr.saveDelegation(tx, actor, p.data));
}
export async function cancelDelegationAction(id: string) {
  return runAction((tx, actor) => appr.cancelDelegation(tx, actor, uuid.parse(id)));
}
export async function bulkDecideAction(stepIds: string[], decision: "approved" | "rejected", comment?: string) {
  const p = z.object({ ids: z.array(uuid).min(1).max(100), decision: z.enum(["approved", "rejected"]), comment: z.string().max(1000).optional() }).safeParse({ ids: stepIds, decision, comment });
  if (!p.success) return bad(p.error);
  return runAction((tx, actor) => appr.bulkDecide(tx, actor, p.data.ids, p.data.decision, p.data.comment));
}

// ---------- Excel bulk update ----------
async function fileFrom(form: FormData) {
  const f = form.get("file");
  if (!(f instanceof File) || f.size === 0) return null;
  return f.arrayBuffer();
}
export async function previewUpdateAction(form: FormData) {
  const bytes = await fileFrom(form);
  if (!bytes) return { ok: false as const, error: "Choose an .xlsx file first." };
  return runAction((tx, actor) => previewUpdate(tx, actor, bytes), { refresh: false });
}
export async function commitUpdateAction(form: FormData) {
  const bytes = await fileFrom(form);
  if (!bytes) return { ok: false as const, error: "Choose an .xlsx file first." };
  return runAction((tx, actor) => commitUpdate(tx, actor, bytes));
}
