import "server-only";
import type { Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { settleAgainstAdvance } from "./rules";

/**
 * What happens when the approval engine finishes a claim. Approval settles the linked advance first: the advance
 * covers what it still can and only the rest is paid out. A claim fully covered by its advance is paid at once.
 * Guarded on status, so a repeat call does nothing.
 */
export async function onExpenseClaimDecided(tx: Tx, actor: Actor | null, claimId: string, final: "approved" | "rejected") {
  const [c] = await tx<{ id: string; total_paise: bigint; advance_id: string | null; employee_id: string; tenant_id: string }[]>`
    update expense_claims set status = ${final} where id = ${claimId} and status = 'submitted'
    returning id, total_paise, advance_id, employee_id, tenant_id`;
  if (!c || final === "rejected") return;
  if (!c.advance_id) return;
  const [a] = await tx<{ id: string; amount_paise: bigint; settled_paise: bigint; status: string }[]>`
    select id, amount_paise, settled_paise, status from expense_advances where id = ${c.advance_id} and employee_id = ${c.employee_id} for update`;
  if (!a || a.status !== "paid") return;
  const s = settleAgainstAdvance(Number(c.total_paise), { amount_paise: Number(a.amount_paise), settled_paise: Number(a.settled_paise) });
  if (s.applied === 0) return;
  await tx`update expense_advances set settled_paise = ${s.settledAfter}, status = ${s.fullySettled ? "settled" : "paid"} where id = ${a.id}`;
  await tx`update expense_claims set advance_applied_paise = ${s.applied} where id = ${c.id}`;
  if (s.payable === 0) {
    await tx`update expense_claims set status = 'paid', payout = 'off_cycle', paid_at = now(), paid_by = ${actor?.userId ?? null}, payment_ref = 'Covered by advance' where id = ${c.id}`;
  }
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff)
           values (${c.tenant_id}, ${actor?.userId ?? null}, 'expense_claim', ${c.id}, 'advance.applied', ${tx.json({ advance_id: a.id, applied_paise: s.applied, payable_paise: s.payable })})`;
}

export async function onExpenseAdvanceDecided(tx: Tx, _actor: Actor | null, advanceId: string, final: "approved" | "rejected") {
  await tx`update expense_advances set status = ${final} where id = ${advanceId} and status = 'pending'`;
}
