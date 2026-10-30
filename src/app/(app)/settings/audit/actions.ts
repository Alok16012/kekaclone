"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import { listAudit, listSignIns } from "@/server/modules/audit/service";
import { cleanFilters } from "@/server/modules/audit/rules";

const filterInput = z.record(z.string().max(20), z.string().max(100).optional());

/** Next page of the audit trail (the first page is rendered by the page itself). */
export async function moreAuditAction(filters: Record<string, string | undefined>, cursor: string) {
  const f = filterInput.safeParse(filters);
  if (!f.success || typeof cursor !== "string") return { ok: false as const, error: "Invalid filters." };
  return runAction((tx, actor) => listAudit(tx, actor, cleanFilters(f.data), cursor), { refresh: false });
}

export async function moreSignInsAction(filters: Record<string, string | undefined>, cursor: string) {
  const f = filterInput.safeParse(filters);
  if (!f.success || typeof cursor !== "string") return { ok: false as const, error: "Invalid filters." };
  const result = f.data.result === "success" || f.data.result === "failure" ? f.data.result : null;
  return runAction((tx, actor) => listSignIns(tx, actor, { ...cleanFilters(f.data), result }, cursor), { refresh: false });
}
