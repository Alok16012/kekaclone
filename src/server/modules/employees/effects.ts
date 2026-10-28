import "server-only";
import type { Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";

/** Writes whitelisted profile columns and records the change on the person's timeline. */
export async function applyProfileChanges(tx: Tx, tenantId: string, employeeId: string, changes: Record<string, unknown>, actorUserId: string | null, kind = "profile_updated") {
  const cols = Object.keys(changes);
  if (!cols.length) return;
  const row = Object.fromEntries(cols.map((c) => [c, typeof changes[c] === "object" && changes[c] !== null ? tx.json(changes[c] as never) : changes[c]]));
  await tx`update employees set ${tx(row as Record<string, never>, cols)} where id = ${employeeId}`;
  await tx`insert into timeline_events (tenant_id, employee_id, kind, effective_date, data, actor_user_id)
           values (${tenantId}, ${employeeId}, ${kind}, current_date, ${tx.json({ fields: cols })}, ${actorUserId})`;
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff)
           values (${tenantId}, ${actorUserId}, 'employee', ${employeeId}, 'update', ${tx.json(changes as never)})`;
}

export async function onProfileChangeDecided(tx: Tx, actor: Actor, requestId: string, final: "approved" | "rejected") {
  const [r] = await tx<{ tenant_id: string; employee_id: string; changes: Record<string, { old: unknown; new: unknown }> }[]>`
    update profile_change_requests set status = ${final} where id = ${requestId} and status = 'pending' returning tenant_id, employee_id, changes`;
  if (!r || final !== "approved") return;
  await applyProfileChanges(tx, r.tenant_id, r.employee_id, Object.fromEntries(Object.entries(r.changes).map(([k, v]) => [k, v.new])), actor.userId);
}
