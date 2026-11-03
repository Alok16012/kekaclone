"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import { todayIn } from "@/lib/dates";
import * as admin from "@/server/modules/leave/admin";
import * as holidays from "@/server/modules/leave/holidays";
import { runAccrual, yearEndPreview, yearEndRun } from "@/server/modules/leave/accrual";
import { assertLeaveAdmin } from "@/server/modules/leave/access";

const uuid = z.uuid();
const bad = (error: string) => ({ ok: false as const, error });
const id = (v: unknown) => uuid.safeParse(v);

// ---------- leave types
export async function saveLeaveTypeAction(typeId: string | null, input: unknown) {
  if (typeId !== null && !id(typeId).success) return bad("Unknown leave type.");
  return runAction((tx, actor) => admin.saveType(tx, actor, typeId, input));
}
export async function deleteLeaveTypeAction(typeId: string) {
  if (!id(typeId).success) return bad("Unknown leave type.");
  return runAction((tx, actor) => admin.deleteType(tx, actor, typeId));
}

// ---------- plans and rules
export async function savePlanAction(planId: string | null, input: unknown) {
  if (planId !== null && !id(planId).success) return bad("Unknown leave plan.");
  return runAction((tx, actor) => admin.savePlan(tx, actor, planId, input));
}
export async function deletePlanAction(planId: string) {
  if (!id(planId).success) return bad("Unknown leave plan.");
  return runAction((tx, actor) => admin.deletePlan(tx, actor, planId));
}
export async function addTypeToPlanAction(planId: string, typeId: string) {
  if (!id(planId).success || !id(typeId).success) return bad("Pick a leave type.");
  return runAction((tx, actor) => admin.addTypeToPlan(tx, actor, planId, typeId));
}
export async function saveRuleAction(ruleId: string, input: unknown) {
  if (!id(ruleId).success) return bad("Unknown rule.");
  return runAction((tx, actor) => admin.saveRule(tx, actor, ruleId, input));
}
export async function removeRuleAction(ruleId: string) {
  if (!id(ruleId).success) return bad("Unknown rule.");
  return runAction((tx, actor) => admin.removeRule(tx, actor, ruleId));
}
export async function assignPlanAction(planId: string, employeeIds: string[]) {
  const ids = z.array(uuid).min(1).max(1000).safeParse(employeeIds);
  if (!id(planId).success || !ids.success) return bad("Choose who to move to this plan.");
  return runAction((tx, actor) => admin.assignPlan(tx, actor, planId, ids.data));
}

// ---------- balances
export async function adjustBalanceAction(input: unknown) {
  return runAction((tx, actor) => admin.adjustBalance(tx, actor, input));
}
export async function ledgerAction(employeeId: string) {
  if (!id(employeeId).success) return bad("Unknown person.");
  return runAction(async (tx, actor) => {
    const r = await admin.ledgerFor(tx, actor, employeeId);
    return { cycleStart: r.cycleStart, entries: r.entries.map((e) => ({ ...e, amount: Number(e.amount), created_at: e.created_at.toISOString() })) };
  }, { refresh: false });
}

async function fileFrom(form: FormData) {
  const f = form.get("file");
  if (!(f instanceof File) || f.size === 0) return null;
  return f.arrayBuffer();
}
export async function previewBalanceImportAction(form: FormData) {
  const bytes = await fileFrom(form);
  if (!bytes) return bad("Choose an .xlsx file first.");
  return runAction((tx, actor) => admin.previewBalanceImport(tx, actor, bytes), { refresh: false });
}
export async function commitBalanceImportAction(form: FormData) {
  const bytes = await fileFrom(form);
  if (!bytes) return bad("Choose an .xlsx file first.");
  return runAction((tx, actor) => admin.commitBalanceImport(tx, actor, bytes));
}

/** Runs today's accruals now (the nightly job does the same); handy right after changing a plan's rules. */
export async function runAccrualNowAction() {
  return runAction(async (tx, actor) => {
    assertLeaveAdmin(actor);
    return runAccrual(tx, actor.tenant.id, todayIn(), { actorUserId: actor.userId });
  });
}

// ---------- year-end
export async function yearEndRunAction(planId: string, encashMonth: string) {
  if (!id(planId).success || !/^\d{4}-\d{2}$/.test(encashMonth)) return bad("Pick a plan and a payroll month.");
  return runAction(async (tx, actor) => {
    await yearEndPreview(tx, actor, planId);   // permission + plan exists
    return yearEndRun(tx, actor, planId, encashMonth);
  });
}

// ---------- holidays
export async function saveHolidayListAction(listId: string | null, input: { name: string; year: number; floaterLimit: number }) {
  if (listId !== null && !id(listId).success) return bad("Unknown holiday list.");
  return runAction((tx, actor) => holidays.saveHolidayList(tx, actor, listId, input));
}
export async function deleteHolidayListAction(listId: string) {
  if (!id(listId).success) return bad("Unknown holiday list.");
  return runAction((tx, actor) => holidays.deleteHolidayList(tx, actor, listId));
}
export async function copyHolidayListAction(listId: string, toYear: number) {
  if (!id(listId).success || !Number.isInteger(toYear) || toYear < 2000 || toYear > 2100) return bad("Pick a year.");
  return runAction((tx, actor) => holidays.copyHolidayList(tx, actor, listId, toYear));
}
export async function saveHolidayAction(listId: string, holidayId: string | null, input: unknown) {
  if (!id(listId).success || (holidayId !== null && !id(holidayId).success)) return bad("Unknown holiday.");
  return runAction((tx, actor) => holidays.saveHoliday(tx, actor, listId, holidayId, input));
}
export async function deleteHolidayAction(holidayId: string) {
  if (!id(holidayId).success) return bad("Unknown holiday.");
  return runAction((tx, actor) => holidays.deleteHoliday(tx, actor, holidayId));
}
export async function assignHolidayListAction(listId: string, input: { locationIds: string[]; employeeIds: string[] }) {
  const p = z.object({ locationIds: z.array(uuid).max(500), employeeIds: z.array(uuid).max(5000) }).safeParse(input);
  if (!id(listId).success || !p.success) return bad("Check who the list applies to.");
  return runAction((tx, actor) => holidays.assignHolidayList(tx, actor, listId, p.data));
}
export async function holidayListPeopleAction(listId: string) {
  if (!id(listId).success) return bad("Unknown holiday list.");
  return runAction(async (tx, actor) => { assertLeaveAdmin(actor); return holidays.holidayListPeople(tx, listId); }, { refresh: false });
}

// ---------------------------------------------------------------- time3: event-based grants, holiday import
import * as grants from "@/server/modules/leave/grants";
import { commitHolidayImport, previewHolidayImport } from "@/server/modules/leave/holidays-import";

export async function grantLeaveAction(input: unknown) {
  return runAction((tx, actor) => grants.grantLeave(tx, actor, input));
}
export async function cancelGrantAction(grantId: string) {
  if (!id(grantId).success) return bad("Unknown grant.");
  return runAction((tx, actor) => grants.cancelGrant(tx, actor, grantId));
}
export async function previewHolidayImportAction(form: FormData) {
  const bytes = await fileFrom(form);
  if (!bytes) return bad("Choose an .xlsx file first.");
  return runAction((tx, actor) => previewHolidayImport(tx, actor, bytes), { refresh: false });
}
export async function commitHolidayImportAction(form: FormData) {
  const bytes = await fileFrom(form);
  if (!bytes) return bad("Choose an .xlsx file first.");
  return runAction((tx, actor) => commitHolidayImport(tx, actor, bytes));
}
