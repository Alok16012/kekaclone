import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canRunPayroll } from "@/server/modules/payrun/access";
import { journal } from "@/server/modules/payrun/reports";
import { csv, rupees } from "@/server/modules/payrun/rules";
import { assertFeature } from "@/server/modules/saas/gate";
import type { AccountingFormat } from "./rules";

/** Finalised payroll runs that can be exported, newest first. Payroll runners only. */
export async function exportableRuns(tx: Tx, actor: Actor) {
  if (!canRunPayroll(actor)) return [];
  const rows = await tx<{ id: string; period_month: string; pay_group: string; status: string; finalized_at: Date | null }[]>`
    select r.id, r.period_month::text, g.name as pay_group, r.status, r.finalized_at from payroll_runs r join pay_groups g on g.id = r.pay_group_id
    where r.status in ('finalized', 'payslips_released', 'paid') order by r.period_month desc, g.name limit 24`;
  return rows.map((r) => ({ ...r, finalized_at: r.finalized_at?.toISOString() ?? null }));
}

/**
 * The payroll journal as an accounting-friendly voucher: one line per ledger, debits then credits, balanced.
 * Ledger names are erp's suggestions; map them to your chart of accounts on import.
 */
export async function accountingExport(tx: Tx, actor: Actor, runId: string, format: AccountingFormat) {
  if (!canRunPayroll(actor)) throw new AppError("forbidden", "Only payroll runners can export the journal.");
  assertFeature(actor, "accounting_export");
  const [run] = await tx<{ period_month: string; status: string }[]>`select period_month::text, status from payroll_runs where id = ${runId}`;
  if (!run) throw new AppError("not_found", "That payroll run doesn't exist.");
  if (!["finalized", "payslips_released", "paid"].includes(run.status)) throw new AppError("invalid", "Finalise the run before exporting it to accounts.");
  const j = await journal(tx, actor, runId);
  const month = run.period_month.slice(0, 7);
  const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0));
  const d = `${String(last.getUTCDate()).padStart(2, "0")}-${String(last.getUTCMonth() + 1).padStart(2, "0")}-${last.getUTCFullYear()}`;
  const voucher = `PAY-${month}`, narration = `Salary for ${month}`;
  const rows = format === "tally"
    ? [["Date", "Voucher Type", "Voucher No", "Ledger", "Debit", "Credit", "Narration"],
      ...j.debits.map((r) => [d, "Journal", voucher, r.account, rupees(r.paise), "", narration]),
      ...j.credits.map((r) => [d, "Journal", voucher, r.account, "", rupees(r.paise), narration])]
    : [["Journal Date", "Reference Number", "Notes", "Account", "Debit", "Credit", "Contact Name"],
      ...j.debits.map((r) => [d, voucher, narration, r.account, rupees(r.paise), "", ""]),
      ...j.credits.map((r) => [d, voucher, narration, r.account, "", rupees(r.paise), ""])];
  return { text: csv(rows), name: `${format}-journal-${month}.csv`, totalDebit: j.totalDebit, totalCredit: j.totalCredit };
}
