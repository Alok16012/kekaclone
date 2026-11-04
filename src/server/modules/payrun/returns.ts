import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { audit } from "@/server/modules/audit/service";
import { isPayrollAdmin } from "@/server/modules/payroll/access";
import { panMap } from "@/server/modules/tax/service";
import { yearSummary } from "@/server/modules/tax/form16";
import { fyEnd, fyLabel } from "@/server/modules/tax/rules";
import { annexure1Csv, annexure2Csv, quarterMonths, type Quarter } from "./tds24q";

const N = (v: bigint | number | string | null | undefined) => (v == null ? 0 : Number(v));

/**
 * Form 24Q data for a quarter: Annexure I from every finalised line in the quarter's months (company-wide, so it needs
 * an unscoped payroll admin), and for Q4 also Annexure II from each person's year. Data exports, not the FVU file.
 */
export async function form24q(tx: Tx, actor: Actor, fyStart: string, q: Quarter, annexure: 1 | 2) {
  if (!/^\d{4}-04-01$/.test(fyStart)) throw new AppError("invalid", "Pick a financial year.");
  if (!isPayrollAdmin(actor)) throw new AppError("forbidden", "Only payroll admins for the whole company can export returns data.");
  const fy = fyLabel(fyStart);
  const pans = await panMap(tx, actor.tenant.id);
  const panOf = new Map([...pans].map(([pan, id]) => [id, pan]));
  if (annexure === 1) {
    const months = quarterMonths(fyStart, q);
    const rows = await tx<{ employee_id: string; number: string; name: string; month: string; paid_on: string | null; taxable: string; tds: string }[]>`
      select l.employee_id, e.employee_number as number, e.display_name as name, r.period_month::text as month, r.finalized_at::date::text as paid_on,
        (l.statutory->>'taxablePaise')::bigint::text as taxable, coalesce((l.statutory->'tds'->>'monthlyPaise')::bigint, 0)::text as tds
      from payroll_lines l join payroll_runs r on r.id = l.run_id join employees e on e.id = l.employee_id
      where r.status in ('finalized','payslips_released','paid') and l.action in ('process','hold_payout','paid_outside') and r.period_month = any(${months}::date[])`;
    const out = annexure1Csv(rows.map((r) => ({ employeeNumber: r.number, name: r.name, pan: panOf.get(r.employee_id) ?? null, month: r.month, paidOn: r.paid_on, amountPaise: N(r.taxable), tdsPaise: N(r.tds) })), { fy, q });
    await audit(tx, actor, { entityType: "payroll_run", entityId: null, action: "payroll.report", diff: { kind: "24q_annexure1", fy, q, rows: out.rows } });
    return out;
  }
  if (q !== 4) throw new AppError("invalid", "Annexure II (salary details for the year) is filed with the fourth quarter.");
  const people = await tx<{ id: string }[]>`
    select distinct l.employee_id as id from payroll_lines l join payroll_runs r on r.id = l.run_id
    where r.status in ('finalized','payslips_released','paid') and r.period_month between ${fyStart} and ${fyEnd(fyStart)}`;
  const rows = [];
  for (const p of people) {
    const s = await yearSummary(tx, p.id, fyStart);
    if (!s) continue;
    rows.push({
      employeeNumber: s.number, name: s.name, pan: s.pan, regime: s.regime, from: s.from, to: s.to,
      grossSalaryPaise: s.grossSalaryPaise, exemptPaise: s.exemptSalaryPaise + s.hraExemptPaise + s.fbpExemptPaise, standardDeductionPaise: s.tax.standardDeductionPaise,
      professionalTaxPaise: s.regime === "new" ? 0 : s.professionalTaxPaise, otherIncomePaise: s.otherIncomePaise, chapterVIAPaise: s.chapterVIAPaise, taxableIncomePaise: s.tax.taxableIncomePaise,
      taxPaise: s.tax.slabTaxPaise, rebatePaise: s.tax.rebatePaise, surchargePaise: s.tax.surchargePaise, cessPaise: s.tax.cessPaise, totalTaxPaise: s.tax.totalTaxPaise, tdsPaise: s.tdsPaise,
      previousEmployerIncomePaise: s.previous.incomePaise, previousEmployerTdsPaise: s.previous.tdsPaise,
    });
  }
  const out = annexure2Csv(rows, { fy });
  await audit(tx, actor, { entityType: "payroll_run", entityId: null, action: "payroll.report", diff: { kind: "24q_annexure2", fy, rows: out.rows } });
  return out;
}
