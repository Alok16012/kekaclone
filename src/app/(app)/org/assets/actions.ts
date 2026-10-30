"use server";
import { z } from "zod";
import { runAction } from "@/server/action";
import { AppError } from "@/server/db";
import * as assets from "@/server/modules/assets/service";
import { rupeesToPaise } from "@/server/modules/assets/rules";

const uuid = z.uuid();
const bad = (error: string, field?: string) => ({ ok: false as const, error, field });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** "₹ 1,250.50" → paise, or a field error. Blank → null. */
function money(v: string | null | undefined, field: string): bigint | null {
  if (v == null || v.trim() === "") return null;
  const p = rupeesToPaise(v);
  if (p == null) throw new AppError("invalid", "Enter an amount in rupees, with at most two decimals.", field);
  return p;
}

// ---------- structure ----------
export async function saveAssetCategoryAction(id: string | null, name: string) {
  if ((id && !uuid.safeParse(id).success) || typeof name !== "string") return bad("Check the category name.");
  return runAction((tx, actor) => assets.saveAssetCategory(tx, actor, id, name.slice(0, 200)));
}
export async function deleteAssetCategoryAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Category not found.");
  return runAction((tx, actor) => assets.deleteAssetCategory(tx, actor, id));
}

const typeInput = z.object({ categoryId: uuid, name: z.string().max(200), requiresAck: z.boolean(), requestable: z.boolean() });
export async function saveAssetTypeAction(id: string | null, raw: z.input<typeof typeInput>) {
  const p = typeInput.safeParse(raw);
  if ((id && !uuid.safeParse(id).success) || !p.success) return bad("Check the asset type details.");
  return runAction((tx, actor) => assets.saveAssetType(tx, actor, id, p.data));
}
export async function deleteAssetTypeAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Asset type not found.");
  return runAction((tx, actor) => assets.deleteAssetType(tx, actor, id));
}

// ---------- items ----------
const assetInput = z.object({
  typeId: uuid, tag: z.string().max(60), name: z.string().max(200), serialNumber: z.string().max(120).nullable().optional(),
  condition: z.enum(["new", "good", "fair", "damaged", "lost"]), status: z.enum(["available", "in_repair", "retired", "assigned"]).nullable().optional(),
  purchaseDate: isoDate.nullable().optional(), cost: z.string().max(30).nullable().optional(),
});
export async function saveAssetAction(id: string | null, raw: z.input<typeof assetInput>) {
  const p = assetInput.safeParse(raw);
  if ((id && !uuid.safeParse(id).success) || !p.success) return bad("Check the asset details.");
  return runAction((tx, actor) => assets.saveAsset(tx, actor, id, { ...p.data, costPaise: money(p.data.cost, "cost") }));
}
export async function deleteAssetAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Asset not found.");
  return runAction((tx, actor) => assets.deleteAsset(tx, actor, id));
}

export async function assetHistoryAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Asset not found.");
  return runAction(async (tx, actor) => (await assets.assetHistory(tx, actor, id)).map((h) => ({
    id: h.id, employee: h.employee, employee_id: h.employee_id, assigned_at: h.assigned_at.toISOString(), acknowledged_at: iso(h.acknowledged_at), returned_at: iso(h.returned_at),
    assign_condition: h.assign_condition, return_condition: h.return_condition, recovery_paise: h.recovery_paise.toString(), notes: h.notes, return_notes: h.return_notes,
    assigned_by: h.assigned_by, returned_by: h.returned_by,
  })), { refresh: false });
}

// ---------- hand over / take back ----------
const assignInput = z.object({ assetIds: z.array(uuid).min(1).max(50), employeeId: uuid, requestId: uuid.nullable().optional(), notes: z.string().max(1000).nullable().optional() });
export async function assignAssetsAction(raw: z.input<typeof assignInput>) {
  const p = assignInput.safeParse(raw);
  if (!p.success) return bad("Pick a person and at least one asset.");
  return runAction(async (tx, actor) => { const r = await assets.assignAssets(tx, actor, p.data); return { count: r.assignmentIds.length }; });
}

const returnInput = z.array(z.object({ assignmentId: uuid, condition: z.enum(["new", "good", "fair", "damaged", "lost"]), recovery: z.string().max(30).nullable().optional(), notes: z.string().max(1000).nullable().optional() })).min(1).max(50);
export async function returnAssetsAction(raw: z.input<typeof returnInput>) {
  const p = returnInput.safeParse(raw);
  if (!p.success) return bad("Check the return details.");
  return runAction(async (tx, actor) => {
    const r = await assets.returnAssets(tx, actor, p.data.map((i) => ({ assignmentId: i.assignmentId, condition: i.condition, recoveryPaise: money(i.recovery, "recovery") ?? BigInt(0), notes: i.notes })));
    return { returned: r.returned, recoveryPaise: r.recoveryPaise.toString() };
  });
}

export async function declineAssetRequestAction(id: string, note?: string) {
  if (!uuid.safeParse(id).success) return bad("Request not found.");
  return runAction((tx, actor) => assets.declineApprovedRequest(tx, actor, id, note?.slice(0, 300)));
}

// ---------- read-only panes used elsewhere (exit checklist, Inbox) ----------
export async function exitAssetsAction(employeeId: string) {
  if (!uuid.safeParse(employeeId).success) return bad("Person not found.");
  return runAction(async (tx, actor) => {
    const r = await assets.exitAssets(tx, actor, employeeId);
    if (!r) throw new AppError("not_found", "You can't see this person's assets.");
    return { canManage: r.canManage, open: r.open.map((o) => ({ id: o.id, tag: o.tag, name: o.name, type: o.type, assigned_at: o.assigned_at.toISOString(), acknowledged: !!o.acknowledged_at })) };
  }, { refresh: false });
}

export async function assetRequestDetailAction(id: string) {
  if (!uuid.safeParse(id).success) return bad("Request not found.");
  return runAction(async (tx, actor) => {
    const d = await assets.requestDetail(tx, actor, id);
    if (!d) throw new AppError("not_found", "This request isn't available.");
    const q = d.request;
    return {
      request: { id: q.id, employee: q.employee, type: q.type, category: q.category, kind: q.kind, reason: q.reason, status: q.status, created_at: q.created_at.toISOString(), available: q.available },
      holding: d.holding.map((h) => ({ tag: h.tag, name: h.name, assigned_at: h.assigned_at.toISOString() })),
    };
  }, { refresh: false });
}
