"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import { AppError } from "@/server/db";
import { MAX_UPLOAD_BYTES } from "@/server/modules/documents/rules";
import * as claims from "@/server/modules/payroll/claims";

const uuid = z.uuid();
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });
const str = (form: FormData, k: string) => { const v = form.get(k); return typeof v === "string" ? v : ""; };

/** A reimbursable claim with its bills (FormData: componentId, claimMonth, amount in rupees, note, bills[]). */
export async function submitClaimAction(form: FormData) {
  const files = form.getAll("bills").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) return bad("Attach at least one bill.", "bills");
  if (files.length > claims.MAX_BILLS) return bad(`Attach up to ${claims.MAX_BILLS} bills.`, "bills");
  if (files.some((f) => f.size > MAX_UPLOAD_BYTES)) return bad("Each bill must be 5 MB or smaller.", "bills");
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(str(form, "amount").replace(/[₹,\s]/g, ""));
  if (!m) return bad("Enter the amount in rupees, like 2500.", "amountPaise");
  const amountPaise = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  const uploads = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
  return runAction((tx, actor) => claims.submitComponentClaim(tx, actor, { componentId: str(form, "componentId"), claimMonth: str(form, "claimMonth"), amountPaise, note: str(form, "note") || null }, uploads));
}

export async function withdrawClaimAction(claimId: string) {
  if (!uuid.safeParse(claimId).success) return bad("Claim not found.");
  return runAction(async (tx, actor) => { await claims.withdrawComponentClaim(tx, actor, claimId); });
}

/** For the inbox drawer (read only). */
export async function componentClaimDetailAction(claimId: string) {
  if (!uuid.safeParse(claimId).success) return bad("Claim not found.");
  return runAction(async (tx, actor) => {
    const d = await claims.componentClaimDetail(tx, actor, claimId);
    if (!d) throw new AppError("not_found", "Claim not found.");
    return d;
  }, { refresh: false });
}
