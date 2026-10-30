"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import * as setup from "@/server/modules/setup/service";
import { isStep } from "@/server/modules/setup/rules";

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
