"use server";
import { runAction } from "@/server/action";
import { recordVerification, type VerificationInput } from "@/server/modules/statutory/service";

/** Record that a CA checked the statutory rates shown on the page (payroll.admin, company-wide). */
export async function recordVerificationAction(input: VerificationInput) {
  if (!input || typeof input !== "object") return { ok: false as const, error: "Check the details." };
  return runAction((tx, actor) => recordVerification(tx, actor, input));
}
