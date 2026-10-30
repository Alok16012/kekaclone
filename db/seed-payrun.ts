/**
 * Demo payroll runs for the seeded tenant (called last from db/seed.ts): last month's run finalised, payslips released and
 * paid; this month's run calculated with a few inputs; and a draft full and final settlement for the person who left.
 * PAN numbers below are made-up test values in the PAN format, not real ones.
 */
import { withTenant } from "@/server/db";
import { encryptField } from "@/server/modules/payroll/secret";
import { computeBreakup } from "@/server/modules/payroll/rules";
import { getStructure, toDef } from "@/server/modules/payroll/setup";
import { computeRun } from "@/server/modules/payrun/engine";
import * as runs from "@/server/modules/payrun/runs";
import { releasePayslips } from "@/server/modules/payrun/payslips";
import { createBatch, markBatchPaid } from "@/server/modules/payrun/payments";
import { buildSettlement } from "@/server/modules/payrun/fnf";
import { addMonths, monthStart, STEPS } from "@/server/modules/payrun/rules";
import { todayIn } from "@/lib/dates";
import type { Actor } from "@/server/auth/session";

export async function seedPayrun(tenantId: string) {
  const today = todayIn();
  const month = monthStart(today), prev = addMonths(month, -1);
  const tenant = { id: tenantId, name: "Acme Technologies", status: "trial", subdomain: "acme" };
  const actor = async (first: string, permissions: string[]): Promise<Actor> => {
    const [e] = await withTenant(tenantId, (tx) => tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`);
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(permissions), grants: [{ permissions, scopes: [] }] };
  };
  const karan = await actor("Karan", ["payroll.admin"]), asha = await actor("Asha", ["*"]);

  const group = await withTenant(tenantId, async (tx) => {
    // professional tax needs a state: the seeded office is in Karnataka
    await tx`update locations set state_code = 'KA' where state_code is null`;
    const people = await tx<{ id: string; first_name: string; employee_number: string }[]>`select id, first_name, employee_number from employees order by employee_number`;
    for (const [i, p] of people.entries()) {
      if (p.first_name === "Fatima") continue;   // no PAN on file: shows the payroll warning
      const pan = `ABCPE${String(1000 + i * 37).padStart(4, "0")}${String.fromCharCode(65 + (i % 26))}`;
      await tx`insert into employee_identities (tenant_id, employee_id, kind, number_enc, number_last4, name_on_doc)
               select ${tenantId}, ${p.id}, 'pan', ${encryptField(pan, ["identity", tenantId, p.id])}, ${pan.slice(-4)}, ${p.first_name}
               where not exists (select 1 from employee_identities where employee_id = ${p.id} and kind = 'pan')`;
    }
    const [g] = await tx<{ id: string }[]>`select id from pay_groups where name = 'Monthly'`;
    const [st] = await tx<{ id: string }[]>`select id from salary_structures where pay_group_id = ${g.id} and name = 'Standard'`;
    // Nikhil left last month without a salary on record; give him one so the settlement has something to work from
    const [nikhil] = await tx<{ id: string; joining_date: string }[]>`select id, joining_date::text from employees where first_name = 'Nikhil'`;
    if (nikhil) {
      const s = await getStructure(tx, st.id);
      const b = computeBreakup(toDef(s!.lines), 840000_00);
      if (b.ok) await tx`insert into employee_salaries (tenant_id, employee_id, structure_id, ctc_paise, effective_from, breakup, reason, status, created_by)
                         values (${tenantId}, ${nikhil.id}, ${st.id}, ${840000_00}, ${nikhil.joining_date}, ${tx.json(b.breakup)}, 'joining', 'active', ${karan.userId})`;
      await tx`update employees set pay_group_id = ${g.id} where id = ${nikhil.id}`;
    }
    return g.id;
  });

  const reviewAll = async (runId: string) => withTenant(tenantId, async (tx) => {
    const v = await runs.runView(tx, karan, runId);
    for (const s of v.steps) if (!s.done) await runs.markReviewed(tx, karan, runId, s.key, true);
  });
  const ids = async (...names: string[]) => withTenant(tenantId, (tx) => tx<{ id: string; first_name: string }[]>`select id, first_name from employees where first_name = any(${names})`)
    .then((r) => Object.fromEntries(r.map((x) => [x.first_name, x.id])));

  // last month: finalised, payslips out, paid (Asha confirms the bank file because it includes Karan's own salary)
  const { id: prevRun } = await withTenant(tenantId, (tx) => runs.createRun(tx, karan, group, prev, today));
  await withTenant(tenantId, (tx) => computeRun(tx, prevRun));
  await reviewAll(prevRun);
  await withTenant(tenantId, async (tx) => { await runs.finalizeRun(tx, karan, prevRun); await releasePayslips(tx, karan, prevRun); });
  const batch = await withTenant(tenantId, (tx) => createBatch(tx, karan, prevRun, "neft_csv"));
  await withTenant(tenantId, (tx) => markBatchPaid(tx, asha, batch.id));
  // Nikhil had no bank account on file: paid by cheque, so the run closes as paid
  await withTenant(tenantId, async (tx) => {
    const [l] = await tx<{ id: string }[]>`select l.id from payroll_lines l join employees e on e.id = l.employee_id where l.run_id = ${prevRun} and e.first_name = 'Nikhil'`;
    if (l) await runs.markLinePaidOutside(tx, asha, l.id, "Cheque 004512");
  });

  // this month: open, with a few inputs, calculated
  const { id: run } = await withTenant(tenantId, (tx) => runs.createRun(tx, karan, group, month, today));
  const p = await ids("Rohan", "Sneha", "Vikram", "Imran", "Nikhil");
  await withTenant(tenantId, async (tx) => {
    await runs.saveInput(tx, karan, run, null, { employeeId: p.Rohan, kind: "bonus", amountPaise: 15000_00, note: "Spot award" });
    await runs.saveInput(tx, karan, run, null, { employeeId: p.Sneha, kind: "adhoc_deduction", amountPaise: 1200_00, note: "Canteen" });
    await runs.saveInput(tx, karan, run, null, { employeeId: p.Vikram, kind: "lop_adjust", days: 1, sourceMonth: prev, note: "Unpaid absence found after last month closed" });
    await runs.saveInput(tx, karan, run, null, { employeeId: p.Imran, kind: "overtime", amountPaise: 2000_00, note: "Weekend stock count" });
    if (p.Nikhil) await runs.setPayAction(tx, karan, run, p.Nikhil, "void", "Final month paid in the full and final settlement");
  });
  await withTenant(tenantId, (tx) => computeRun(tx, run));
  await withTenant(tenantId, async (tx) => { await runs.markReviewed(tx, karan, run, STEPS[0].key, true); });

  // the person who left: a draft settlement to review
  await withTenant(tenantId, async (tx) => {
    const [x] = await tx<{ id: string }[]>`select x.id from exit_requests x join employees e on e.id = x.employee_id where e.first_name = 'Nikhil' and x.status = 'exited'`;
    if (x) await buildSettlement(tx, karan, x.id);
  });
}
