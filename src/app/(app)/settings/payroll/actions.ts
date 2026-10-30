"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import { todayIn } from "@/lib/dates";
import * as setup from "@/server/modules/payroll/setup";
import * as revisions from "@/server/modules/payroll/revisions";

const uuid = z.uuid();
const bad = (error: string) => ({ ok: false as const, error, field: undefined as string | undefined });
const isId = (v: unknown) => uuid.safeParse(v).success;

// ---------- components
export async function saveComponentAction(id: string | null, input: unknown) {
  if (id !== null && !isId(id)) return bad("Unknown component.");
  return runAction((tx, actor) => setup.saveComponent(tx, actor, id, input));
}
export async function deleteComponentAction(id: string) {
  if (!isId(id)) return bad("Unknown component.");
  return runAction((tx, actor) => setup.deleteComponent(tx, actor, id));
}

// ---------- pay groups
export async function savePayGroupAction(id: string | null, input: unknown) {
  if (id !== null && !isId(id)) return bad("Unknown pay group.");
  return runAction((tx, actor) => setup.savePayGroup(tx, actor, id, input));
}
export async function deletePayGroupAction(id: string) {
  if (!isId(id)) return bad("Unknown pay group.");
  return runAction((tx, actor) => setup.deletePayGroup(tx, actor, id));
}
export async function payGroupPeopleAction(id: string) {
  if (!isId(id)) return bad("Unknown pay group.");
  return runAction((tx, actor) => setup.payGroupPeople(tx, actor, id), { refresh: false });
}
export async function assignPayGroupAction(id: string, employeeIds: string[]) {
  const ids = z.array(uuid).min(1, "Pick at least one person").max(5000).safeParse(employeeIds);
  if (!isId(id) || !ids.success) return bad("Pick who to add to this pay group.");
  return runAction((tx, actor) => setup.assignPayGroup(tx, actor, id, ids.data));
}

// ---------- structures (returns the id so a new structure can open its own page; no redirect from actions)
export async function saveStructureAction(id: string | null, input: unknown) {
  if (id !== null && !isId(id)) return bad("Unknown structure.");
  return runAction((tx, actor) => setup.saveStructure(tx, actor, id, input));
}
export async function deleteStructureAction(id: string) {
  if (!isId(id)) return bad("Unknown structure.");
  return runAction((tx, actor) => setup.deleteStructure(tx, actor, id));
}

// ---------- statutory sign-off
export async function recordCaVerificationAction(input: unknown) {
  return runAction((tx, actor) => setup.recordCaVerification(tx, actor, input, todayIn()));
}

// ---------- bulk revisions
async function fileFrom(form: FormData) {
  const f = form.get("file");
  if (!(f instanceof File) || f.size === 0) return null;
  return f.arrayBuffer();
}
export async function previewRevisionsAction(form: FormData) {
  const bytes = await fileFrom(form);
  if (!bytes) return bad("Choose an .xlsx file first.");
  return runAction((tx, actor) => revisions.previewRevisionImport(tx, actor, bytes), { refresh: false });
}
export async function commitRevisionsAction(form: FormData) {
  const bytes = await fileFrom(form);
  if (!bytes) return bad("Choose an .xlsx file first.");
  return runAction((tx, actor) => revisions.commitRevisionImport(tx, actor, bytes));
}
