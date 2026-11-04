"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import { AppError } from "@/server/db";
import * as setup from "@/server/modules/setup/service";
import { isStep } from "@/server/modules/setup/rules";
import { deleteHoliday, saveHoliday } from "@/server/modules/leave/holidays";

const companyInput = z.object({
  name: z.string().max(200), pan: z.string().max(20).optional(), tan: z.string().max(20).optional(),
  line1: z.string().max(300).optional(), line2: z.string().max(300).optional(), city: z.string().max(100).optional(),
  state: z.string().max(5).optional(), pincode: z.string().max(10).optional(),
});

export async function openSetupAction() {
  return runAction((tx, actor) => setup.openSetup(tx, actor).then(() => undefined), { refresh: false });
}

export async function saveCompanyAction(input: z.input<typeof companyInput>) {
  const parsed = companyInput.safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Check the company details." };
  return runAction((tx, actor) => setup.saveCompany(tx, actor, parsed.data).then(() => undefined));
}

export async function saveLeaveBasicsAction(input: { yearStart: string; quotas: Record<string, string | number> }) {
  const parsed = z.object({ yearStart: z.string().max(5), quotas: z.record(z.string().max(4), z.union([z.string().max(10), z.number()])) }).safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Check the leave quotas." };
  return runAction((tx, actor) => setup.saveLeaveBasics(tx, actor, parsed.data));
}

export async function savePoliciesAction(input: { shiftStart: string; shiftEnd: string; weeklyOff: string; cutoffDay?: string | number | null }) {
  const parsed = z.object({ shiftStart: z.string().max(5), shiftEnd: z.string().max(5), weeklyOff: z.string().max(20), cutoffDay: z.union([z.string().max(3), z.number()]).nullable().optional() }).safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Check the policy details." };
  return runAction((tx, actor) => setup.savePolicies(tx, actor, parsed.data).then(() => undefined));
}

/** Holidays on the policies step go straight into this year's holiday list (leave settings own the rest). */
export async function setupHolidayAction(input: { name: string; date: string; floater?: boolean }) {
  const parsed = z.object({ name: z.string().max(80), date: z.string().max(10), floater: z.boolean().optional() }).safeParse(input);
  if (!parsed.success) return { ok: false as const, error: "Check the holiday details." };
  return runAction(async (tx, actor) => {
    const listId = await setup.setupHolidayList(tx, actor);
    return saveHoliday(tx, actor, listId, null, { name: parsed.data.name, date: parsed.data.date, floater: parsed.data.floater ?? false, description: "" });   // Global admins hold every permission
  });
}

export async function deleteSetupHolidayAction(id: string) {
  if (!z.uuid().safeParse(id).success) return { ok: false as const, error: "Holiday not found." };
  return runAction(async (tx, actor) => { if (!setup.isGlobalAdmin(actor)) throw new AppError("forbidden", "Only a Global admin can run company setup."); await deleteHoliday(tx, actor, id); });
}

export async function completeStepAction(step: string, status: "done" | "skipped") {
  if (!isStep(step)) return { ok: false as const, error: "Unknown step." };
  const s = z.enum(["done", "skipped"]).safeParse(status);
  if (!s.success) return { ok: false as const, error: "Unknown status." };
  return runAction((tx, actor) => setup.completeStep(tx, actor, step, s.data).then(() => undefined));
}

export async function inviteEveryoneAction() {
  return runAction((tx, actor) => setup.inviteEveryone(tx, actor));
}

export async function finishSetupAction() {
  return runAction((tx, actor) => setup.finishSetup(tx, actor).then(() => undefined));
}
