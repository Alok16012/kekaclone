import "server-only";
import type { Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";

/** Called by the approvals engine when the chain finishes. Guarded on status, so a repeat call does nothing. */
export async function onTimesheetDecided(tx: Tx, actor: Actor | null, id: string, final: "approved" | "rejected") {
  const [ts] = await tx<{ id: string }[]>`update timesheets set status = ${final}, decided_at = now(), updated_at = now() where id = ${id} and status = 'submitted' returning id`;
  if (!ts) return;
  const [step] = await tx<{ comment: string | null }[]>`
    select s.comment from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_type = 'timesheet' and r.entity_id = ${id} and s.status = 'rejected' order by s.acted_at desc limit 1`;
  if (final === "rejected" && step?.comment) await tx`update timesheets set decision_comment = ${step.comment} where id = ${id}`;
}

