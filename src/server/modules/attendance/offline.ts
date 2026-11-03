import "server-only";
import type { Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { addDaysISO, todayIn } from "@/lib/dates";
import { processAttendance } from "./process";
import { parseQueue, planQueuedPunches } from "./offline-rules";

export type SyncResult = { accepted: string[]; rejected: { client_id: string; reason: string }[] };

/**
 * Record punches the phone queued while offline (see features/clock-card.tsx). Oldest first, alternating with the
 * server's last punch, inside the last 48 hours, idempotent by client id. Geofence / office-network checks are not
 * re-run for a queued punch (the network was down); the location the phone saved is stored with it.
 */
export async function syncQueuedPunches(tx: Tx, actor: Actor, raw: unknown, now = new Date()): Promise<SyncResult> {
  await tx`select pg_advisory_xact_lock(hashtext(${"punch:" + actor.employeeId}))`;
  const { items, bad } = parseQueue(raw);
  const result: SyncResult = { accepted: [], rejected: [...bad] };
  if (!items.length) return result;
  // punches already recorded for these ids (a retry after a lost response): report them as accepted, don't re-plan them
  const known = await tx<{ client_id: string }[]>`select client_id from punches where employee_id = ${actor.employeeId} and client_id = any(${items.map((i) => i.client_id)}::text[])`;
  const knownIds = new Set(known.map((k) => k.client_id));
  for (const id of knownIds) result.accepted.push(id);
  const fresh = items.filter((i) => !knownIds.has(i.client_id));
  if (!fresh.length) return result;
  const [last] = await tx<{ direction: "in" | "out"; at: Date }[]>`select direction, at from punches where employee_id = ${actor.employeeId} and status = 'valid' and direction in ('in','out') order by at desc limit 1`;
  const plan = planQueuedPunches(fresh, { lastDirection: last?.direction ?? null, lastAt: last?.at.toISOString() ?? null, now });
  result.rejected.push(...plan.reject);
  const dates = new Set<string>();
  for (const p of plan.accept) {
    const r = await tx`insert into punches (tenant_id, employee_id, at, direction, source, lat, lng, accuracy_m, comment, client_id)
      values (${actor.tenant.id}, ${actor.employeeId}, ${new Date(p.at)}, ${p.expect}, 'web', ${p.lat ?? null}, ${p.lng ?? null}, ${p.accuracy ?? null}, ${p.comment ? `${p.comment} (queued offline)` : "queued offline"}, ${p.client_id})
      on conflict (employee_id, client_id) where client_id is not null do nothing`;
    result.accepted.push(p.client_id);
    if (r.count) { const d = todayIn("Asia/Kolkata", new Date(p.at)); dates.add(addDaysISO(d, -1)); dates.add(d); }
  }
  for (const d of dates) await processAttendance(tx, actor.tenant.id, actor.employeeId, d, { now });
  if (plan.accept.length) await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff) values (${actor.tenant.id}, ${actor.userId}, 'employee', ${actor.employeeId}, 'punch.offline_sync', ${tx.json({ accepted: plan.accept.length, rejected: plan.reject.length })})`;
  return result;
}
