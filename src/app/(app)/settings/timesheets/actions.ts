"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import { savePolicy } from "@/server/modules/psa/service";

const schema = z.object({
  cadence: z.enum(["weekly", "daily"]), min_minutes_per_day: z.number().int(), min_minutes_per_week: z.number().int(), max_minutes_per_day: z.number().int(),
  lock_after_days: z.number().int().nullable(), approver: z.enum(["project", "manager"]), allow_future: z.boolean(), require_note: z.boolean(),
});

export async function saveTimesheetPolicyAction(input: unknown) {
  const p = schema.safeParse(input);
  if (!p.success) return { ok: false as const, error: "Check the policy values.", field: p.error.issues[0]?.path.join(".") };
  return runAction((tx, actor) => savePolicy(tx, actor, p.data));
}
