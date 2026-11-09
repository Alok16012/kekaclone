import "server-only";
import { autoTickExitTasks } from "@/server/modules/exits/checklist";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { cancelApproval, startApproval } from "@/server/modules/approvals/service";
import { ASSETS_ADMIN, assetAdminsFor, notify, onAssetRequestDecided, placementOf } from "./effects";
import {
  afterReturn, canAssign, checkRecovery, CONDITIONS, DEFAULT_ASSET_CATEGORIES, MANUAL_STATUSES, normaliseTag, totalRecovery,
  type AssetStatus, type Condition, type RequestStatus,
} from "./rules";

export { ASSETS_ADMIN, onAssetRequestDecided };
const EVERYWHERE: Placement = { department_id: null, location_id: null, legal_entity_id: null, business_unit_id: null };
/** The inventory (categories, types, items) is company-wide: editing it needs assets.admin with no scope. */
export const canManageInventory = (actor: Actor) => canFor(actor, ASSETS_ADMIN, EVERYWHERE);
/** Any assets.admin grant, scoped or not: may open the inventory and hand assets to people in scope. */
export const hasAssetsAccess = (actor: Actor) => actor.grants.some((g) => g.permissions.includes("*") || g.permissions.includes(ASSETS_ADMIN));

const forbidden = () => new AppError("forbidden", "You don't have access to do this.");
function assertInventory(actor: Actor) { if (!canManageInventory(actor)) throw forbidden(); }

// ---------- defaults ----------
export async function ensureAssetDefaults(tx: Tx, tenantId: string) {
  for (const c of DEFAULT_ASSET_CATEGORIES) {
    await tx`insert into asset_categories (tenant_id, name) values (${tenantId}, ${c.name}) on conflict (tenant_id, name) do nothing`;
    const [cat] = await tx<{ id: string }[]>`select id from asset_categories where name = ${c.name}`;
    for (const t of c.types) {
      await tx`insert into asset_types (tenant_id, category_id, name, requires_ack, requestable) values (${tenantId}, ${cat.id}, ${t.name}, ${t.requiresAck}, ${t.requestable})
               on conflict (category_id, name) do nothing`;
    }
  }
}

// ---------- categories and types ----------
export type TypeRow = { id: string; category_id: string; name: string; requires_ack: boolean; requestable: boolean; total: number; available: number };
export type CategoryRow = { id: string; name: string; types: TypeRow[] };

export async function structure(tx: Tx): Promise<CategoryRow[]> {
  const cats = await tx<{ id: string; name: string }[]>`select id, name from asset_categories order by name`;
  const types = await tx<TypeRow[]>`
    select t.id, t.category_id, t.name, t.requires_ack, t.requestable,
      (select count(*)::int from assets a where a.type_id = t.id and a.status <> 'retired') as total,
      (select count(*)::int from assets a where a.type_id = t.id and a.status = 'available' and a.condition not in ('damaged','lost')) as available
    from asset_types t order by t.name`;
  return cats.map((c) => ({ ...c, types: types.filter((t) => t.category_id === c.id) }));
}

const cleanName = (s: string, what: string, field = "name") => {
  const n = s.trim().slice(0, 80);
  if (!n) throw new AppError("invalid", `Give the ${what} a name.`, field);
  return n;
};

export async function saveAssetCategory(tx: Tx, actor: Actor, id: string | null, name: string) {
  assertInventory(actor);
  const n = cleanName(name, "category");
  const [dup] = await tx<{ id: string }[]>`select id from asset_categories where lower(name) = lower(${n}) and id is distinct from ${id}`;
  if (dup) throw new AppError("conflict", "A category with this name already exists.", "name");
  const [r] = id ? await tx<{ id: string }[]>`update asset_categories set name = ${n} where id = ${id} returning id`
    : await tx<{ id: string }[]>`insert into asset_categories (tenant_id, name) values (${actor.tenant.id}, ${n}) returning id`;
  if (!r) throw new AppError("not_found", "Category not found.");
  return r;
}

export async function deleteAssetCategory(tx: Tx, actor: Actor, id: string) {
  assertInventory(actor);
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from asset_types where category_id = ${id}`;
  if (n) throw new AppError("invalid", "Delete or move the asset types in this category first.");
  const r = await tx`delete from asset_categories where id = ${id}`;
  if (!r.count) throw new AppError("not_found", "Category not found.");
}

export async function saveAssetType(tx: Tx, actor: Actor, id: string | null, input: { categoryId: string; name: string; requiresAck: boolean; requestable: boolean }) {
  assertInventory(actor);
  const n = cleanName(input.name, "asset type");
  const [cat] = await tx<{ id: string }[]>`select id from asset_categories where id = ${input.categoryId}`;
  if (!cat) throw new AppError("not_found", "Pick a category.", "categoryId");
  const [dup] = await tx<{ id: string }[]>`select id from asset_types where category_id = ${cat.id} and lower(name) = lower(${n}) and id is distinct from ${id}`;
  if (dup) throw new AppError("conflict", "This category already has a type with this name.", "name");
  const [r] = id
    ? await tx<{ id: string }[]>`update asset_types set category_id = ${cat.id}, name = ${n}, requires_ack = ${input.requiresAck}, requestable = ${input.requestable} where id = ${id} returning id`
    : await tx<{ id: string }[]>`insert into asset_types (tenant_id, category_id, name, requires_ack, requestable) values (${actor.tenant.id}, ${cat.id}, ${n}, ${input.requiresAck}, ${input.requestable}) returning id`;
  if (!r) throw new AppError("not_found", "Asset type not found.");
  return r;
}

export async function deleteAssetType(tx: Tx, actor: Actor, id: string) {
  assertInventory(actor);
  const [{ n }] = await tx<{ n: number }[]>`select (select count(*) from assets where type_id = ${id}) + (select count(*) from asset_requests where type_id = ${id}) as n`;
  if (Number(n)) throw new AppError("invalid", "This type has assets or requests, so it can't be deleted.");
  const r = await tx`delete from asset_types where id = ${id}`;
  if (!r.count) throw new AppError("not_found", "Asset type not found.");
}

// ---------- inventory ----------
export type AssetRow = {
  id: string; tag: string; name: string; serial_number: string | null; condition: Condition; status: AssetStatus; purchase_date: string | null; cost_paise: bigint | null;
  type_id: string; type: string; category: string; requires_ack: boolean;
  assignment_id: string | null; holder_id: string | null; holder: string | null; assigned_at: Date | null; acknowledged_at: Date | null;
};

export async function inventory(tx: Tx, actor: Actor): Promise<AssetRow[]> {
  if (!hasAssetsAccess(actor)) throw forbidden();
  return tx<AssetRow[]>`
    select a.id, a.tag, a.name, a.serial_number, a.condition, a.status, a.purchase_date::text, a.cost_paise, a.type_id, t.name as type, c.name as category, t.requires_ack,
      g.id as assignment_id, g.employee_id as holder_id, e.display_name as holder, g.assigned_at, g.acknowledged_at
    from assets a join asset_types t on t.id = a.type_id join asset_categories c on c.id = t.category_id
    left join asset_assignments g on g.asset_id = a.id and g.returned_at is null left join employees e on e.id = g.employee_id
    order by a.tag`;
}

export type AssetInput = { typeId: string; tag: string; name: string; serialNumber?: string | null; condition: string; status?: string | null; purchaseDate?: string | null; costPaise?: bigint | null };

export async function saveAsset(tx: Tx, actor: Actor, id: string | null, input: AssetInput) {
  assertInventory(actor);
  const tag = normaliseTag(input.tag);
  if (!tag) throw new AppError("invalid", "Use 2–40 letters, digits or dashes for the tag, e.g. LAP-0012.", "tag");
  const name = cleanName(input.name, "asset");
  if (!(CONDITIONS as string[]).includes(input.condition)) throw new AppError("invalid", "Pick a condition.", "condition");
  if (input.costPaise != null && input.costPaise < BigInt(0)) throw new AppError("invalid", "The cost can't be negative.", "cost");
  if (input.purchaseDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.purchaseDate)) throw new AppError("invalid", "Pick the purchase date.", "purchaseDate");
  const [type] = await tx<{ id: string }[]>`select id from asset_types where id = ${input.typeId}`;
  if (!type) throw new AppError("not_found", "Pick an asset type.", "typeId");
  const [dup] = await tx<{ id: string }[]>`select id from assets where tag = ${tag} and id is distinct from ${id}`;
  if (dup) throw new AppError("conflict", "Another asset already has this tag.", "tag");
  const serial = input.serialNumber?.trim().slice(0, 80) || null;
  if (id) {
    const [cur] = await tx<{ status: AssetStatus }[]>`select status from assets where id = ${id} for update`;
    if (!cur) throw new AppError("not_found", "Asset not found.");
    let status: AssetStatus = cur.status;
    if (input.status && input.status !== cur.status) {
      if (cur.status === "assigned") throw new AppError("invalid", "This asset is with someone. Take it back first.", "status");
      if (!(MANUAL_STATUSES as string[]).includes(input.status)) throw new AppError("invalid", "Assets are marked assigned by handing them over.", "status");
      status = input.status as AssetStatus;
    }
    await tx`update assets set type_id = ${type.id}, tag = ${tag}, name = ${name}, serial_number = ${serial}, condition = ${input.condition}, status = ${status},
             purchase_date = ${input.purchaseDate || null}, cost_paise = ${input.costPaise == null ? null : input.costPaise.toString()} where id = ${id}`;
    return { id };
  }
  const status = input.status && (MANUAL_STATUSES as string[]).includes(input.status) ? input.status : "available";
  const [r] = await tx<{ id: string }[]>`
    insert into assets (tenant_id, type_id, tag, name, serial_number, condition, status, purchase_date, cost_paise)
    values (${actor.tenant.id}, ${type.id}, ${tag}, ${name}, ${serial}, ${input.condition}, ${status}, ${input.purchaseDate || null}, ${input.costPaise == null ? null : input.costPaise.toString()}) returning id`;
  return r;
}

/** Assets that were never handed out can be deleted; anything with history is retired instead. */
export async function deleteAsset(tx: Tx, actor: Actor, id: string) {
  assertInventory(actor);
  const [{ n }] = await tx<{ n: number }[]>`select count(*)::int as n from asset_assignments where asset_id = ${id}`;
  if (n) throw new AppError("invalid", "This asset has been handed out before. Mark it retired to keep its history.");
  const r = await tx`delete from assets where id = ${id}`;
  if (!r.count) throw new AppError("not_found", "Asset not found.");
}

export type HistoryRow = {
  id: string; asset_id: string; tag: string; asset: string; type: string; employee_id: string; employee: string; assigned_at: Date; acknowledged_at: Date | null;
  returned_at: Date | null; assign_condition: Condition | null; return_condition: Condition | null; recovery_paise: bigint; notes: string | null; return_notes: string | null;
  assigned_by: string | null; returned_by: string | null;
};

const historySelect = (tx: Tx) => tx`
  select g.id, g.asset_id, a.tag, a.name as asset, t.name as type, g.employee_id, e.display_name as employee, g.assigned_at, g.acknowledged_at, g.returned_at,
    g.assign_condition, g.return_condition, g.recovery_paise, g.notes, g.return_notes, ab.display_name as assigned_by, rb.display_name as returned_by
  from asset_assignments g join assets a on a.id = g.asset_id join asset_types t on t.id = a.type_id join employees e on e.id = g.employee_id
  left join employees ab on ab.user_id = g.assigned_by left join employees rb on rb.user_id = g.returned_by`;

export async function assetHistory(tx: Tx, actor: Actor, assetId: string) {
  if (!hasAssetsAccess(actor)) throw forbidden();
  return tx<HistoryRow[]>`${historySelect(tx)} where g.asset_id = ${assetId} order by g.assigned_at desc limit 100`;
}

// ---------- hand over / take back ----------
async function assertPersonInScope(tx: Tx, actor: Actor, employeeId: string, verb: string) {
  const p = await placementOf(tx, employeeId);
  if (!p) throw new AppError("not_found", "Person not found.", "employeeId");
  if (employeeId === actor.employeeId) throw new AppError("forbidden", `You can't ${verb} your own assets. Ask another admin.`);
  if (!canFor(actor, ASSETS_ADMIN, p)) throw forbidden();
  return p;
}

export async function assignAssets(tx: Tx, actor: Actor, input: { assetIds: string[]; employeeId: string; requestId?: string | null; notes?: string | null }, now = new Date()) {
  const ids = [...new Set(input.assetIds)];
  if (!ids.length) throw new AppError("invalid", "Pick at least one asset.", "assetIds");
  if (ids.length > 50) throw new AppError("invalid", "Hand over at most 50 assets at a time.", "assetIds");
  const p = await assertPersonInScope(tx, actor, input.employeeId, "hand out");
  if (p.status === "relieved") throw new AppError("invalid", "This person has left the company.", "employeeId");
  const assets = await tx<{ id: string; tag: string; name: string; status: AssetStatus; condition: Condition; type_id: string; type: string; requires_ack: boolean }[]>`
    select a.id, a.tag, a.name, a.status, a.condition, a.type_id, t.name as type, t.requires_ack from assets a join asset_types t on t.id = a.type_id
    where a.id = any(${ids}::uuid[]) order by a.tag for update of a`;
  if (assets.length !== ids.length) throw new AppError("not_found", "Some of these assets no longer exist.");
  for (const a of assets) {
    const ok = canAssign(a);
    if (!ok.ok) throw new AppError("conflict", `${a.tag} ${ok.reason}.`, "assetIds");
  }
  if (input.requestId) {
    if (assets.length !== 1) throw new AppError("invalid", "Hand over one asset for a request.");
    const [q] = await tx<{ id: string }[]>`
      update asset_requests set status = 'fulfilled' where id = ${input.requestId} and employee_id = ${input.employeeId} and status = 'approved' and type_id = ${assets[0].type_id} returning id`;
    if (!q) throw new AppError("conflict", "This request isn't waiting to be handed over, or the asset is a different type.");
  }
  const notes = input.notes?.trim().slice(0, 1000) || null;
  const out: string[] = [];
  for (const a of assets) {
    try {
      const [g] = await tx.savepoint((sp) => sp<{ id: string }[]>`
        insert into asset_assignments (tenant_id, asset_id, employee_id, assigned_at, assigned_by, assign_condition, notes, request_id)
        values (${actor.tenant.id}, ${a.id}, ${input.employeeId}, ${now}, ${actor.userId}, ${a.condition}, ${notes}, ${input.requestId ?? null}) returning id`);
      out.push(g.id);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new AppError("conflict", `${a.tag} is already with someone.`);
      throw e;
    }
    await tx`update assets set status = 'assigned' where id = ${a.id}`;
  }
  const needAck = assets.filter((a) => a.requires_ack);
  const list = assets.map((a) => `${a.name} (${a.tag})`).join(", ");
  await notify(tx, actor.tenant.id, input.employeeId, "assets.assigned", needAck.length ? "Please confirm the assets you received" : "Assets handed over to you", list, "/me/assets");
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff)
           select ${actor.tenant.id}, ${actor.userId}, 'asset', a, 'asset.assign', ${tx.json({ employee_id: input.employeeId, request_id: input.requestId ?? null })} from unnest(${ids}::uuid[]) a`;
  return { assignmentIds: out };
}

export type ReturnItem = { assignmentId: string; condition: string; recoveryPaise: bigint; notes?: string | null };

/** Take assets back (bulk). Each item records the condition and any recovery; the asset goes back on the shelf, to repair, or is retired if lost. */
export async function returnAssets(tx: Tx, actor: Actor, items: ReturnItem[], now = new Date()) {
  if (!items.length) throw new AppError("invalid", "Pick at least one asset to take back.");
  if (items.length > 50) throw new AppError("invalid", "Take back at most 50 assets at a time.");
  if (new Set(items.map((i) => i.assignmentId)).size !== items.length) throw new AppError("invalid", "An asset is listed twice.");
  let total = BigInt(0);
  for (const it of items) {
    if (!(CONDITIONS as string[]).includes(it.condition)) throw new AppError("invalid", "Pick the condition it came back in.", "condition");
    const [g] = await tx<{ id: string; employee_id: string; asset_id: string; tag: string; cost_paise: bigint | null }[]>`
      select g.id, g.employee_id, g.asset_id, a.tag, a.cost_paise from asset_assignments g join assets a on a.id = g.asset_id
      where g.id = ${it.assignmentId} and g.returned_at is null for update of g, a`;
    if (!g) throw new AppError("conflict", "This asset was already taken back.");
    await assertPersonInScope(tx, actor, g.employee_id, "take back");
    const cond = it.condition as Condition;
    const rec = checkRecovery(cond, it.recoveryPaise, g.cost_paise);
    if (!rec.ok) throw new AppError("invalid", `${g.tag}: ${rec.error}`, "recovery");
    const r = await tx`update asset_assignments set returned_at = ${now}, return_condition = ${cond}, recovery_paise = ${rec.paise.toString()}, return_notes = ${it.notes?.trim().slice(0, 1000) || null}, returned_by = ${actor.userId}
                       where id = ${g.id} and returned_at is null`;
    if (!r.count) throw new AppError("conflict", "This asset was already taken back.");
    const next = afterReturn(cond);
    await tx`update assets set status = ${next.status}, condition = ${next.condition} where id = ${g.asset_id}`;
    await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff)
             values (${actor.tenant.id}, ${actor.userId}, 'asset', ${g.asset_id}, 'asset.return', ${tx.json({ employee_id: g.employee_id, condition: cond, recovery_paise: rec.paise.toString() })})`;
    if (rec.paise > BigInt(0)) {
      await notify(tx, actor.tenant.id, g.employee_id, "assets.recovery", `Recovery recorded for ${g.tag}`, `An amount will be recovered in your settlement for this asset (${cond}).`, "/me/assets");
    }
    total += rec.paise;
  }
  for (const id of new Set(items.map((i) => i.assignmentId))) {
    const [g] = await tx<{ employee_id: string }[]>`select employee_id from asset_assignments where id = ${id}`;
    if (g) await autoTickExitTasks(tx, { employeeId: g.employee_id });   // a leaver's "return assets" task ticks itself once nothing is left out
  }
  return { returned: items.length, recoveryPaise: total };
}

/** The holder confirms they received an asset. Idempotent: the first time is kept. */
export async function acknowledgeAssignment(tx: Tx, actor: Actor, assignmentId: string, now = new Date()) {
  const [g] = await tx<{ acknowledged_at: Date }[]>`
    update asset_assignments set acknowledged_at = coalesce(acknowledged_at, ${now}) where id = ${assignmentId} and employee_id = ${actor.employeeId} and returned_at is null
    returning acknowledged_at`;
  if (!g) throw new AppError("not_found", "Asset not found.");
  return g;
}

// ---------- a person's assets ----------
export type OpenAssignment = { id: string; asset_id: string; tag: string; name: string; type: string; category: string; serial_number: string | null; assigned_at: Date; acknowledged_at: Date | null; requires_ack: boolean; assign_condition: Condition | null };

/** Assets someone is holding right now. Used by the profile tab, My assets and the exit checklist. */
export async function openAssignmentsFor(tx: Tx, employeeId: string): Promise<OpenAssignment[]> {
  return tx<OpenAssignment[]>`
    select g.id, g.asset_id, a.tag, a.name, t.name as type, c.name as category, a.serial_number, g.assigned_at, g.acknowledged_at, t.requires_ack, g.assign_condition
    from asset_assignments g join assets a on a.id = g.asset_id join asset_types t on t.id = a.type_id join asset_categories c on c.id = t.category_id
    where g.employee_id = ${employeeId} and g.returned_at is null order by g.assigned_at desc`;
}

/** Total damage / loss recovery recorded on someone's returns, in paise (for the full and final settlement). */
export async function assetRecoveryFor(tx: Tx, employeeId: string): Promise<{ totalPaise: bigint; items: { tag: string; asset: string; condition: Condition; recovery_paise: bigint; returned_at: Date }[] }> {
  const items = await tx<{ tag: string; asset: string; condition: Condition; recovery_paise: bigint; returned_at: Date }[]>`
    select a.tag, a.name as asset, g.return_condition as condition, g.recovery_paise, g.returned_at from asset_assignments g join assets a on a.id = g.asset_id
    where g.employee_id = ${employeeId} and g.returned_at is not null and g.recovery_paise > 0 order by g.returned_at`;
  return { totalPaise: totalRecovery(items), items };
}

export type RequestRow = {
  id: string; employee_id: string; employee: string; type_id: string; type: string; category: string; kind: "new" | "replacement"; reason: string | null; status: RequestStatus;
  created_at: Date; updated_at: Date; available: number;
};

const requestSelect = (tx: Tx) => tx`
  select q.id, q.employee_id, e.display_name as employee, q.type_id, t.name as type, c.name as category, q.kind, q.reason, q.status, q.created_at, q.updated_at,
    (select count(*)::int from assets a where a.type_id = q.type_id and a.status = 'available' and a.condition not in ('damaged','lost')) as available
  from asset_requests q join employees e on e.id = q.employee_id join asset_types t on t.id = q.type_id join asset_categories c on c.id = t.category_id`;

async function personAccess(tx: Tx, actor: Actor, employeeId: string) {
  const p = await placementOf(tx, employeeId);
  if (!p) return null;
  const self = actor.employeeId === employeeId;
  const manage = !self && canFor(actor, ASSETS_ADMIN, p);
  const read = self || manage || p.manager_id === actor.employeeId || canFor(actor, "employees.read", p) || canFor(actor, "exits.manage", p);
  return read ? { self, manage, p } : null;
}

/** The profile's Assets tab and My assets: what they hold, their history and their requests. Null when the actor can't see it. */
export async function personAssets(tx: Tx, actor: Actor, employeeId: string) {
  const acc = await personAccess(tx, actor, employeeId);
  if (!acc) return null;
  const [open, history, requests] = await Promise.all([
    openAssignmentsFor(tx, employeeId),
    tx<HistoryRow[]>`${historySelect(tx)} where g.employee_id = ${employeeId} and g.returned_at is not null order by g.returned_at desc limit 50`,
    tx<RequestRow[]>`${requestSelect(tx)} where q.employee_id = ${employeeId} order by q.created_at desc limit 50`,
  ]);
  return { open, history, requests, isSelf: acc.self, canManage: acc.manage };
}

/** For the exit checklist's "return assets" task: what the person still holds. Same access as the profile tab. */
export async function exitAssets(tx: Tx, actor: Actor, employeeId: string) {
  const acc = await personAccess(tx, actor, employeeId);
  if (!acc) return null;
  return { open: await openAssignmentsFor(tx, employeeId), canManage: acc.manage };
}

// ---------- requests ----------
export async function requestableTypes(tx: Tx) {
  return tx<{ id: string; name: string; category: string }[]>`
    select t.id, t.name, c.name as category from asset_types t join asset_categories c on c.id = t.category_id where t.requestable order by c.name, t.name`;
}

export async function requestAsset(tx: Tx, actor: Actor, input: { typeId: string; kind: string; reason?: string | null }) {
  if (input.kind !== "new" && input.kind !== "replacement") throw new AppError("invalid", "Say whether this is a new asset or a replacement.", "kind");
  const reason = input.reason?.trim().slice(0, 1000) || null;
  if (input.kind === "replacement" && !reason) throw new AppError("invalid", "Tell us what's wrong with the one you have.", "reason");
  const [t] = await tx<{ id: string; name: string; requestable: boolean }[]>`select id, name, requestable from asset_types where id = ${input.typeId}`;
  if (!t) throw new AppError("not_found", "Pick what you need.", "typeId");
  if (!t.requestable) throw new AppError("invalid", "This can't be requested. Ask your HR team.", "typeId");
  let id: string;
  try {
    const [q] = await tx.savepoint((sp) => sp<{ id: string }[]>`
      insert into asset_requests (tenant_id, employee_id, type_id, kind, reason) values (${actor.tenant.id}, ${actor.employeeId}, ${t.id}, ${input.kind}, ${reason}) returning id`);
    id = q.id;
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new AppError("conflict", `You already have an open request for a ${t.name.toLowerCase()}.`, "typeId");
    throw e;
  }
  const a = await startApproval(tx, { tenantId: actor.tenant.id, entityType: "asset_request", entityId: id, requesterId: actor.employeeId,
    summary: `${actor.name} · ${t.name}${input.kind === "replacement" ? " (replacement)" : ""}` });
  if (a.status === "approved") await onAssetRequestDecided(tx, actor, id, "approved");   // nobody to ask: straight to the asset team
  return { id, status: a.status === "approved" ? "approved" as const : "pending" as const };
}

export async function cancelRequest(tx: Tx, actor: Actor, id: string) {
  const [q] = await tx<{ id: string }[]>`update asset_requests set status = 'cancelled' where id = ${id} and employee_id = ${actor.employeeId} and status in ('pending','approved') returning id`;
  if (!q) throw new AppError("conflict", "This request can't be cancelled any more.");
  await cancelApproval(tx, "asset_request", id);
}

/** Asset admin closes an approved request without handing anything over (e.g. no stock). */
export async function declineApprovedRequest(tx: Tx, actor: Actor, id: string, note?: string | null) {
  const [q] = await tx<{ employee_id: string; type: string }[]>`select q.employee_id, t.name as type from asset_requests q join asset_types t on t.id = q.type_id where q.id = ${id} and q.status = 'approved'`;
  if (!q) throw new AppError("conflict", "This request isn't waiting to be handed over.");
  await assertPersonInScope(tx, actor, q.employee_id, "decide on");
  await tx`update asset_requests set status = 'rejected' where id = ${id} and status = 'approved'`;
  await notify(tx, actor.tenant.id, q.employee_id, "assets.request_declined", `Your ${q.type.toLowerCase()} request was closed`, note?.trim().slice(0, 300) || "Talk to your HR team for details.", "/me/assets");
}

/** Requests the asset admin can see: open ones (pending approval or to hand over) and the last 30 days of closed ones, within their scope. */
export async function requestsQueue(tx: Tx, actor: Actor) {
  if (!hasAssetsAccess(actor)) throw forbidden();
  const rows = await tx<(RequestRow & Placement)[]>`
    select r.*, e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id from (${requestSelect(tx)}) r join employees e on e.id = r.employee_id
    where r.status in ('pending','approved') or r.updated_at > now() - interval '30 days' order by r.status = 'approved' desc, r.status = 'pending' desc, r.created_at`;
  return rows.filter((r) => canFor(actor, ASSETS_ADMIN, r)).map((r) => ({ ...r, mine: r.employee_id === actor.employeeId }));
}

/** One request with its approvals, for the Inbox. Visible to the requester, approvers on it and asset admins in scope. */
export async function requestDetail(tx: Tx, actor: Actor, id: string) {
  const [q] = await tx<RequestRow[]>`${requestSelect(tx)} where q.id = ${id}`;
  if (!q) return null;
  const p = await placementOf(tx, q.employee_id);
  const [{ approver }] = await tx<{ approver: boolean }[]>`
    select exists(select 1 from approval_requests r join approval_steps s on s.request_id = r.id where r.entity_type = 'asset_request' and r.entity_id = ${id} and s.approver_employee_id = ${actor.employeeId}) as approver`;
  if (q.employee_id !== actor.employeeId && !approver && !(p && canFor(actor, ASSETS_ADMIN, p))) return null;
  const holding = await openAssignmentsFor(tx, q.employee_id);
  return { request: q, holding: holding.filter((h) => h.type === q.type) };
}

export { assetAdminsFor };
