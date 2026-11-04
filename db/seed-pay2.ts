/**
 * Demo data for the pay2 package (called last from db/seed.ts):
 *   - Bhola, a daily-wage worker in the Monthly pay group on a "Daily wage" structure (₹800 a day), with 22 payable days
 *     entered in last month's open run
 *   - FUEL (reimbursable, ₹24,000 a year) and TELEPHONE (earning, ₹18,000 a year) marked as flexible benefits, GL codes on
 *     the standard components for the Tally / Zoho exports
 *   - Arjun's flexible benefit declaration (fuel ₹12,000), Meera's fuel claim with a bill waiting for Rohan
 *   - exchange rates for USD and EUR, entered by Karan
 */
import { PDFDocument, StandardFonts } from "pdf-lib";
import { withTenant } from "@/server/db";
import { createEmployee } from "@/server/modules/employees/service";
import { saveSalary } from "@/server/modules/payroll/salary";
import { saveComponent, saveStructure } from "@/server/modules/payroll/setup";
import { submitComponentClaim } from "@/server/modules/payroll/claims";
import { computeRun } from "@/server/modules/payrun/engine";
import * as runs from "@/server/modules/payrun/runs";
import { saveFbp } from "@/server/modules/tax/fbp";
import { fyStartOf } from "@/server/modules/tax/rules";
import { saveRate } from "@/server/modules/expenses/fx";
import { applyAssignments } from "@/server/modules/learn/service";
import { addMonths, monthStart } from "@/server/modules/payrun/rules";
import { addDaysISO, todayIn } from "@/lib/dates";
import type { Actor } from "@/server/auth/session";

export async function seedPay2(tenantId: string) {
  const today = todayIn();
  const month = addMonths(monthStart(today), -1);
  const tenant = { id: tenantId, name: "Acme Technologies", status: "trial", subdomain: "acme" };
  const actor = async (first: string, permissions: string[]): Promise<Actor> => {
    const [e] = await withTenant(tenantId, (tx) => tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`);
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(permissions), grants: [{ permissions, scopes: [] }] };
  };
  const karan = await actor("Karan", ["payroll.admin", "payroll.run", "expenses.payout"]);
  const arjun = await actor("Arjun", []), meera = await actor("Meera", []);

  // components: GL codes, flexible benefits
  await withTenant(tenantId, async (tx) => {
    for (const [code, gl] of [["BASIC", "5001"], ["HRA", "5002"], ["SPECIAL", "5003"], ["PF_EMPLOYER", "5101"]]) await tx`update salary_components set gl_code = ${gl} where code = ${code}`;
    const has = async (code: string) => (await tx<{ id: string }[]>`select id from salary_components where code = ${code}`)[0];
    if (!(await has("FUEL"))) await saveComponent(tx, karan, null, { name: "Fuel reimbursement", code: "FUEL", kind: "reimbursable", taxable: false, taxSection: "10(14)", lopProrated: false, frequency: "monthly", onPayslip: true, inArrears: false, pfWage: false, esiWage: false, isFbp: true, annualMaxPaise: 24_000_00, glCode: "5120" });
    if (!(await has("TELEPHONE"))) await saveComponent(tx, karan, null, { name: "Telephone allowance", code: "TELEPHONE", kind: "earning", taxable: true, lopProrated: true, frequency: "monthly", onPayslip: true, inArrears: true, pfWage: false, esiWage: true, isFbp: true, annualMaxPaise: 18_000_00, glCode: "5004" });
  });

  // Bhola: daily-wage worker, ₹800 a day (the structure's monthly figure is the rate per day; "annual CTC" = 12 × that)
  const bhola = await withTenant(tenantId, async (tx) => {
    const [exists] = await tx<{ id: string }[]>`select id from employees where work_email = 'bhola@acme.test'`;
    if (exists) return exists.id;
    const [ops] = await tx<{ id: string }[]>`select id from departments where name = 'Operations'`;
    const [title] = await tx<{ id: string }[]>`select id from designations where title = 'Operations Associate'`;
    const [mgr] = await tx<{ id: string }[]>`select id from employees where first_name = 'Priya'`;
    const e = await createEmployee(tx, tenantId, { firstName: "Bhola", lastName: "Yadav", workEmail: "bhola@acme.test", joiningDate: addDaysISO(today, -200), departmentId: ops.id, designationId: title.id, managerId: mgr.id, workerType: "daily" }, null);
    const [group] = await tx<{ id: string }[]>`select id from pay_groups where name = 'Monthly'`;
    const [loc] = await tx<{ location_id: string | null; legal_entity_id: string | null }[]>`select location_id, legal_entity_id from employees where first_name = 'Divya'`;
    await tx`update employees set pay_group_id = ${group.id}, location_id = coalesce(location_id, ${loc?.location_id ?? null}), legal_entity_id = coalesce(legal_entity_id, ${loc?.legal_entity_id ?? null}) where id = ${e.employeeId}`;
    await tx`insert into employee_statutory (employee_id, tenant_id, pf_enabled, esi_enabled, pt_state) values (${e.employeeId}, ${tenantId}, false, true, 'KA') on conflict (employee_id) do nothing`;
    const [basic] = await tx<{ id: string }[]>`select id from salary_components where code = 'BASIC'`;
    let [st] = await tx<{ id: string }[]>`select id from salary_structures where name = 'Daily wage'`;
    if (!st) st = await saveStructure(tx, karan, null, { name: "Daily wage", payGroupId: group.id, lines: [{ componentId: basic.id, calc: "balancing" }] });
    await saveSalary(tx, karan, { employeeId: e.employeeId, structureId: st.id, ctcPaise: 800_00 * 12, effectiveFrom: addDaysISO(today, -200), reason: "joining" }, { notify: false });
    return e.employeeId;
  });
  // a new joiner picks up the published course rules, as the daily job would do
  await withTenant(tenantId, (tx) => applyAssignments(tx, tenantId, today));
  await withTenant(tenantId, async (tx) => {
    const [run] = await tx<{ id: string }[]>`select r.id from payroll_runs r join pay_groups g on g.id = r.pay_group_id where g.name = 'Monthly' and r.period_month = ${month} and r.status in ('draft','in_progress')`;
    if (!run) return;
    const [has] = await tx`select 1 from payroll_inputs i join payroll_runs r on r.pay_group_id = i.pay_group_id and r.period_month = i.period_month where r.id = ${run.id} and i.employee_id = ${bhola} and i.kind = 'payable_units'`;
    if (!has) await runs.saveInput(tx, karan, run.id, null, { employeeId: bhola, kind: "payable_units", days: 22, note: "Muster roll" });
    await computeRun(tx, run.id);
  });

  // flexible benefits and a reimbursable claim
  const fy = fyStartOf(today);
  await withTenant(tenantId, (tx) => saveFbp(tx, arjun, fy, { FUEL: 12_000_00 }, today));
  await withTenant(tenantId, async (tx) => {
    const [exists] = await tx`select 1 from component_claims where employee_id = ${meera.employeeId}`;
    if (exists) return;
    const [fuel] = await tx<{ id: string }[]>`select id from salary_components where code = 'FUEL'`;
    const doc = await PDFDocument.create();
    const page = doc.addPage([420, 300]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    ["Fuel bill", "HP Petrol Pump, Bengaluru", "Total Rs. 1,500.00"].forEach((l, i) => page.drawText(l, { x: 24, y: 260 - i * 20, size: i ? 10 : 14, font }));
    await submitComponentClaim(tx, meera, { componentId: fuel.id, claimMonth: month, amountPaise: 1_500_00, note: "Client visits" }, [{ name: "fuel-bill.pdf", bytes: new Uint8Array(await doc.save()) }], today);
  });

  // exchange rates
  await withTenant(tenantId, async (tx) => {
    await saveRate(tx, karan, { currency: "USD", asOf: addDaysISO(today, -10), rate: "83.25" });
    await saveRate(tx, karan, { currency: "EUR", asOf: addDaysISO(today, -10), rate: "90.10" });
  });
}
