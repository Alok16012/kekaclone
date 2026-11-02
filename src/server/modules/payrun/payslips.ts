import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { audit } from "@/server/modules/audit/service";
import { notifyEmployee } from "@/server/modules/approvals/service";
import { ratesNeedVerification } from "@/server/modules/statutory/service";
import { fyOf, fyRange } from "@/server/modules/statutory/rules";
import { financesFor } from "@/server/modules/payroll/salary";
import { saveFile } from "@/server/storage";
import { assertRunPayroll, canRunPayroll } from "./access";
import { getRun } from "./engine";
import { renderPayslip, type PayslipDoc } from "./pdf";
import { isLockedStatus, monthLabel, type PayItem } from "./rules";
import { settleIfPaid } from "./payments";

const N = (v: bigint | number | null | undefined) => (v == null ? 0 : Number(v));

type SlipRow = {
  slip_id: string; line_id: string; employee_id: string; period_month: string; name: string; number: string; designation: string | null; department: string | null; joining: string;
  period_days: string; payable_days: string; lop_days: string; earnings: PayItem[]; deductions: PayItem[]; employer: PayItem[];
  gross_paise: bigint; total_deductions_paise: bigint; net_paise: bigint; uan: string | null; bank_last4: string | null; bank_name: string | null; pan_last4: string | null;
};

/** Year-to-date figures for one person, up to and including `month`, from finalised runs. */
export async function ytdFor(tx: Tx, employeeId: string, month: string) {
  const [r] = await tx<{ gross: string; deductions: string; net: string; tds: string; pf: string; months: number }[]>`
    select coalesce(sum(l.gross_paise), 0)::text as gross, coalesce(sum(l.total_deductions_paise), 0)::text as deductions, coalesce(sum(l.net_paise), 0)::text as net,
      coalesce(sum((l.statutory->'tds'->>'monthlyPaise')::bigint), 0)::text as tds, coalesce(sum((l.statutory->'pf'->>'employeePaise')::bigint), 0)::text as pf,
      count(distinct r.period_month)::int as months
    from payroll_lines l join payroll_runs r on r.id = l.run_id
    where l.employee_id = ${employeeId} and r.status in ('finalized','payslips_released','paid') and l.action in ('process','hold_payout','paid_outside')
      and r.period_month between ${fyRange(fyOf(month)).from} and ${month}`;
  return { gross: Number(r.gross), deductions: Number(r.deductions), net: Number(r.net), tds: Number(r.tds), pf: Number(r.pf), months: r.months };
}

async function slipDoc(tx: Tx, s: SlipRow, company: string, legalEntity: string, unverified: boolean): Promise<PayslipDoc> {
  const items = (xs: PayItem[]) => xs.filter((x) => x.paise !== 0).map((x): [string, number] => [x.label, x.paise]);
  return {
    company, legalEntity, monthLabel: monthLabel(s.period_month),
    employee: { name: s.name, number: s.number, designation: s.designation, department: s.department, joining: s.joining,
      pan: s.pan_last4 ? `XXXXXX${s.pan_last4}` : null, uan: s.uan, bank: s.bank_last4 ? `${s.bank_name ?? "Bank"} ····${s.bank_last4}` : null },
    days: { period: Number(s.period_days), payable: Number(s.payable_days), lop: Number(s.lop_days) },
    earnings: items(s.earnings ?? []), deductions: items(s.deductions ?? []), gross: N(s.gross_paise), totalDeductions: N(s.total_deductions_paise), net: N(s.net_paise),
    employer: items(s.employer ?? []), ytd: await ytdFor(tx, s.employee_id, s.period_month), unverified,
  };
}

const slipSelect = (tx: Tx) => tx`
  select p.id as slip_id, l.id as line_id, l.employee_id, r.period_month::text, e.display_name as name, e.employee_number as number, d.title as designation, dp.name as department,
    e.joining_date::text as joining, l.period_days::text, l.payable_days::text, l.lop_days::text, l.earnings, l.deductions, l.employer, l.gross_paise, l.total_deductions_paise, l.net_paise,
    st.uan, b.account_last4 as bank_last4, b.bank_name, (select i.number_last4 from employee_identities i where i.employee_id = e.id and i.kind = 'pan' limit 1) as pan_last4
  from payroll_lines l join payroll_runs r on r.id = l.run_id left join payslips p on p.line_id = l.id join employees e on e.id = l.employee_id
  left join designations d on d.id = e.designation_id left join departments dp on dp.id = e.department_id
  left join employee_statutory st on st.employee_id = e.id left join employee_bank_accounts b on b.employee_id = e.id and b.is_primary`;

/**
 * Render and publish payslips for a finalised run (PDF per person, stored as a file) and tell each person.
 * Idempotent: payslips already released are left alone, so it can be re-run after a failure.
 */
export async function releasePayslips(tx: Tx, actor: Actor, runId: string) {
  assertRunPayroll(actor);
  const run = await getRun(tx, runId, true);
  if (!isLockedStatus(run.status)) throw new AppError("conflict", "Finalise the run before releasing payslips.");
  const [t] = await tx<{ name: string }[]>`select name from tenants where id = ${actor.tenant.id}`;
  const unverified = await ratesNeedVerification(tx);
  const slips = await tx<SlipRow[]>`${slipSelect(tx)} where l.run_id = ${runId} and p.id is not null and p.released_at is null order by e.employee_number`;
  for (const s of slips) {
    const bytes = await renderPayslip(await slipDoc(tx, s, t?.name ?? actor.tenant.name, run.legal_entity, unverified));
    const fileId = await saveFile(tx, { tenantId: actor.tenant.id, userId: actor.userId, name: `Payslip ${run.period_month.slice(0, 7)} ${s.number}.pdf`, mime: "application/pdf", bytes, ext: "pdf" });
    await tx`update payslips set file_id = ${fileId}, released_at = now(), updated_at = now() where id = ${s.slip_id}`;
    await notifyEmployee(tx, actor.tenant.id, s.employee_id, "payroll.payslip", `Your payslip for ${monthLabel(run.period_month)} is ready`, "Open My finances to view or download it.", "/me/pay");
  }
  if (run.status === "finalized") await tx`update payroll_runs set status = 'payslips_released', lock_version = lock_version + 1, updated_at = now() where id = ${runId}`;
  await audit(tx, actor, { entityType: "payroll_run", entityId: runId, action: "payroll.payslips_released", diff: { released: slips.length } });
  await settleIfPaid(tx, runId);
  return { released: slips.length };
}

/** A PDF payslip for a preview (the actor's own released one, or any line for payroll), rendered on the fly. */
export async function previewPayslip(tx: Tx, actor: Actor, lineId: string) {
  const [s] = await tx<(SlipRow & { status: string; legal_entity: string })[]>`
    select q.*, r.status, le.name as legal_entity from (${slipSelect(tx)}) q join payroll_lines l on l.id = q.line_id join payroll_runs r on r.id = l.run_id
    join pay_groups g on g.id = r.pay_group_id join legal_entities le on le.id = g.legal_entity_id where q.line_id = ${lineId}`;
  if (!s || !canRunPayroll(actor)) return null;
  const [t] = await tx<{ name: string }[]>`select name from tenants where id = ${actor.tenant.id}`;
  return renderPayslip(await slipDoc(tx, s, t?.name ?? actor.tenant.name, s.legal_entity, await ratesNeedVerification(tx)));
}

/** The employee's own pay page: released payslips, the current breakup, and a final settlement statement if any. */
export async function myPay(tx: Tx, actor: Actor) {
  const slips = await tx<{ id: string; period_month: string; file_id: string | null; released_at: Date; net_paise: bigint; gross_paise: bigint; total_deductions_paise: bigint; payable_days: string; period_days: string }[]>`
    select p.id, p.period_month::text, p.file_id, p.released_at, l.net_paise, l.gross_paise, l.total_deductions_paise, l.payable_days::text, l.period_days::text
    from payslips p join payroll_lines l on l.id = p.line_id
    where p.employee_id = ${actor.employeeId} and p.released_at is not null order by p.period_month desc`;
  const [fnf] = await tx<{ statement_file_id: string | null; net_paise: bigint | null; updated_at: Date }[]>`
    select statement_file_id, net_paise, updated_at from fnf_settlements where employee_id = ${actor.employeeId} and status = 'finalized' order by updated_at desc limit 1`;
  const latest = slips[0];
  return {
    slips: slips.map((s) => ({ id: s.id, month: s.period_month, label: monthLabel(s.period_month), fileId: s.file_id, releasedAt: s.released_at.toISOString(),
      net: N(s.net_paise), gross: N(s.gross_paise), deductions: N(s.total_deductions_paise), payableDays: Number(s.payable_days), periodDays: Number(s.period_days) })),
    ytd: latest ? { ...(await ytdFor(tx, actor.employeeId, latest.period_month)), fy: fyOf(latest.period_month) } : null,
    finances: await financesFor(tx, actor, actor.employeeId),
    fnf: fnf ? { fileId: fnf.statement_file_id, net: N(fnf.net_paise), at: fnf.updated_at.toISOString() } : null,
  };
}

/**
 * Who may open a payroll file: a released payslip → its owner or payroll; a final settlement statement → the person
 * (once finalised) or payroll; a bank transfer file → payroll only. Anything else isn't a payroll file.
 */
export async function payrollFileFor(tx: Tx, actor: Actor, fileId: string) {
  const [f] = await tx<{ id: string; storage_key: string; name: string; mime: string; slip_owner: string | null; slip_released: boolean | null; fnf_owner: string | null; fnf_final: boolean | null; batch: boolean }[]>`
    select f.id, f.storage_key, f.name, f.mime,
      (select p.employee_id from payslips p where p.file_id = f.id limit 1) as slip_owner, (select p.released_at is not null from payslips p where p.file_id = f.id limit 1) as slip_released,
      (select s.employee_id from fnf_settlements s where s.statement_file_id = f.id limit 1) as fnf_owner, (select s.status = 'finalized' from fnf_settlements s where s.statement_file_id = f.id limit 1) as fnf_final,
      exists (select 1 from payment_batches b where b.file_id = f.id) as batch
    from files f where f.id = ${fileId}`;
  if (!f) return null;
  const payroll = canRunPayroll(actor);
  if (f.slip_owner) return f.slip_owner === actor.employeeId && f.slip_released ? f : payroll ? f : null;
  if (f.fnf_owner) return f.fnf_owner === actor.employeeId && f.fnf_final ? f : payroll ? f : null;
  if (f.batch) return payroll ? f : null;
  return null;
}
