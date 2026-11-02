import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { audit } from "@/server/modules/audit/service";
import { notifyEmployee } from "@/server/modules/approvals/service";
import { bankAccountFor } from "@/server/modules/payroll/salary";
import { markPayrollExpensesPaid } from "@/server/modules/expenses/service";
import { markLoanEmisDeducted } from "@/server/modules/loans/service";
import { saveFile } from "@/server/storage";
import { todayIn } from "@/lib/dates";
import { assertRunPayroll } from "./access";
import { getRun } from "./engine";
import { BANK_FORMATS, bankable, bankFile, isLockedStatus, monthLabel, type BankFormat, type BankRow } from "./rules";

const N = (v: bigint | number | null | undefined) => (v == null ? 0 : Number(v));

/** Lines that still need paying by bank transfer: processed, positive, not in a live batch. */
async function unbatched(tx: Tx, runId: string) {
  return tx<{ id: string; employee_id: string; number: string; name: string; net_paise: bigint; action: string }[]>`
    select l.id, l.employee_id, e.employee_number as number, e.display_name as name, l.net_paise, l.action from payroll_lines l join employees e on e.id = l.employee_id
    where l.run_id = ${runId} and l.action = 'process' and l.net_paise > 0
      and not exists (select 1 from payment_batches b where b.run_id = l.run_id and b.status in ('generated','paid') and l.id = any(b.line_ids))
    order by e.employee_number`;
}

/**
 * Bank transfer file for a finalised run: everyone processed with a bank account and not already in a file.
 * People without a bank account are left out and listed. The file holds full account numbers, so it is stored like any
 * other file and only payroll can open it.
 */
export async function createBatch(tx: Tx, actor: Actor, runId: string, format: BankFormat) {
  assertRunPayroll(actor);
  if (!(format in BANK_FORMATS)) throw new AppError("invalid", "Pick a file format.");
  const run = await getRun(tx, runId, true);
  if (!isLockedStatus(run.status) || run.status === "paid") throw new AppError("conflict", "Bank files can be made once the run is finalised and until it's paid.");
  const lines = await unbatched(tx, runId);
  const rows: BankRow[] = [], skipped: string[] = [], ids: string[] = [];
  for (const l of lines) {
    const b = await bankAccountFor(tx, actor.tenant.id, l.employee_id);
    if (!b) { skipped.push(l.name); continue; }
    rows.push({ employeeNumber: l.number, name: l.name, holderName: b.holderName, accountNumber: b.accountNumber, ifsc: b.ifsc, bankName: b.bankName, netPaise: N(l.net_paise) });
    ids.push(l.id);
  }
  if (!rows.length) throw new AppError("invalid", skipped.length ? `Nobody left to pay has a bank account (${skipped.join(", ")}).` : "Everyone in this run is already in a bank file or doesn't need one.");
  const f = BANK_FORMATS[format];
  const text = bankFile(format, rows, { month: run.period_month, valueDate: todayIn(), payerIfscPrefix: null });
  const total = rows.reduce((t, r) => t + r.netPaise, 0);
  const fileId = await saveFile(tx, { tenantId: actor.tenant.id, userId: actor.userId, name: `salary-${run.period_month.slice(0, 7)}-${format}.${f.ext}`, mime: f.mime, bytes: new TextEncoder().encode(text), ext: f.ext });
  const [b] = await tx<{ id: string }[]>`
    insert into payment_batches (tenant_id, run_id, bank_format, line_ids, total_paise, file_id) values (${actor.tenant.id}, ${runId}, ${format}, ${ids}::uuid[], ${total}, ${fileId}) returning id`;
  await audit(tx, actor, { entityType: "payment_batch", entityId: b.id, action: "payroll.bank_file", diff: { runId, format, people: ids.length, totalPaise: total, skipped } });
  return { id: b.id, fileId, people: ids.length, totalPaise: total, skipped };
}

export async function cancelBatch(tx: Tx, actor: Actor, batchId: string) {
  assertRunPayroll(actor);
  const [b] = await tx<{ status: string; run_id: string }[]>`select status, run_id from payment_batches where id = ${batchId} for update`;
  if (!b) throw new AppError("not_found", "Bank file not found.");
  if (b.status !== "generated") throw new AppError("conflict", "Only a bank file that hasn't been marked paid can be cancelled.");
  await tx`update payment_batches set status = 'cancelled', updated_at = now() where id = ${batchId}`;
  await audit(tx, actor, { entityType: "payment_batch", entityId: batchId, action: "payroll.bank_file_cancelled", diff: { runId: b.run_id } });
}

/** Confirm the bank has paid a file. Nobody confirms a payment of their own salary. */
export async function markBatchPaid(tx: Tx, actor: Actor, batchId: string) {
  assertRunPayroll(actor);
  const [b] = await tx<{ status: string; run_id: string; line_ids: string[] }[]>`select status, run_id, line_ids from payment_batches where id = ${batchId} for update`;
  if (!b) throw new AppError("not_found", "Bank file not found.");
  if (b.status === "paid") return { changed: false };
  if (b.status !== "generated") throw new AppError("conflict", "This bank file was cancelled.");
  const [mine] = await tx`select 1 from payroll_lines where id = any(${b.line_ids}::uuid[]) and employee_id = ${actor.employeeId}`;
  if (mine) throw new AppError("forbidden", "This file includes your own salary, so another payroll admin has to confirm it was paid.");
  await tx`update payment_batches set status = 'paid', paid_at = now(), updated_at = now() where id = ${batchId}`;
  const people = await tx<{ employee_id: string }[]>`select employee_id from payroll_lines where id = any(${b.line_ids}::uuid[])`;
  const run = await getRun(tx, b.run_id);
  for (const p of people) await notifyEmployee(tx, actor.tenant.id, p.employee_id, "payroll.paid", `Your ${monthLabel(run.period_month)} salary has been paid`, "It should reach your bank account shortly.", "/me/pay");
  await audit(tx, actor, { entityType: "payment_batch", entityId: batchId, action: "payroll.bank_file_paid", diff: { runId: b.run_id, people: people.length } });
  await settleIfPaid(tx, b.run_id);
  return { changed: true };
}

/** When every line that needs a bank transfer is in a paid file, the run is paid, and its scheduled expense claims are too. */
export async function settleIfPaid(tx: Tx, runId: string) {
  const run = await getRun(tx, runId, true);
  if (!isLockedStatus(run.status) || run.status === "paid") return false;
  const left = await unbatched(tx, runId);
  const [pending] = await tx`select 1 from payment_batches where run_id = ${runId} and status = 'generated' limit 1`;
  const [holds] = await tx`select 1 from payroll_lines where run_id = ${runId} and action = 'hold_payout' limit 1`;
  if (left.some((l) => bankable(l.action, N(l.net_paise))) || pending || holds) return false;
  await tx`update payroll_runs set status = 'paid', lock_version = lock_version + 1, updated_at = now() where id = ${runId}`;
  await markPayrollExpensesPaid(tx, run.pay_group_id, run.period_month, { runId });
  await markLoanEmisDeducted(tx, run.pay_group_id, run.period_month, { runId });
  return true;
}
