/**
 * Demo payroll foundation for the seeded tenant (called from db/seed.ts): default components, the "Monthly" pay group
 * and "Standard" structure, Karan as payroll admin, a Karnataka head office (drives PT), and a CTC for every active
 * employee from their joining date, with an April revision for a few people. Bank accounts and statutory IDs are
 * made-up test values (not real accounts).
 */
import { withTenant } from "@/server/db";
import { ensurePayrollDefaults } from "@/server/modules/payroll/defaults";
import { saveBankAccount, saveSalary, saveStatutory } from "@/server/modules/payroll/salary";
import { todayIn } from "@/lib/dates";
import type { Actor } from "@/server/auth/session";

/** Annual CTC in rupees by first name. */
const CTC: Record<string, number> = {
  Asha: 4800000, Priya: 1800000, Karan: 1500000, Rohan: 2400000, Arjun: 1200000, Meera: 1350000, Vikram: 1100000,
  Sneha: 900000, Imran: 600000, Divya: 420000, Aditya: 380000, Fatima: 720000,
};
const RAISE: Record<string, number> = { Arjun: 1380000, Meera: 1500000, Sneha: 1000000 };

export async function seedPayFoundation(tenantId: string) {
  const today = todayIn();
  const tenant = { id: tenantId, name: "Acme Technologies", status: "trial", subdomain: "acme" };
  const actor = async (first: string, permissions: string[]): Promise<Actor> => {
    const [e] = await withTenant(tenantId, (tx) => tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`);
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(permissions), grants: [{ permissions, scopes: [] }] };
  };

  const ids = await withTenant(tenantId, async (tx) => {
    const d = await ensurePayrollDefaults(tx, tenantId);
    await tx`insert into roles (tenant_id, key, name, is_system, permissions) select ${tenantId}, 'payroll_admin', 'Payroll admin', true, ${["payroll.admin", "employees.read"]}
             where not exists (select 1 from roles where key = 'payroll_admin')`;
    await tx`insert into role_assignments (tenant_id, role_id, employee_id) select ${tenantId}, r.id, e.id from roles r, employees e
             where r.key = 'payroll_admin' and e.first_name = 'Karan' and not exists (select 1 from role_assignments x where x.role_id = r.id and x.employee_id = e.id)`;
    await tx`update locations set state_code = 'KA' where name = 'Head office' and state_code is null`;
    return d!;
  });

  // Karan (payroll admin) sets everyone up; Asha (global admin) sets up Karan, since nobody sets their own pay.
  const karan = await actor("Karan", ["payroll.admin"]);
  const asha = await actor("Asha", ["*"]);
  const people = await withTenant(tenantId, (tx) => tx<{ id: string; first_name: string; joining_date: string }[]>`
    select id, first_name, joining_date::text from employees where status <> 'relieved' order by employee_number`);
  for (const [i, p] of people.entries()) {
    const ctc = CTC[p.first_name];
    if (!ctc) continue;
    const by = p.first_name === "Karan" ? asha : karan;
    await withTenant(tenantId, async (tx) => {
      await saveSalary(tx, by, { employeeId: p.id, structureId: ids.structureId, ctcPaise: ctc * 100, effectiveFrom: p.joining_date, reason: "joining" }, { notify: false });
      const april = `${today.slice(0, 4)}-04-01`;
      if (RAISE[p.first_name] && april > p.joining_date && april <= today) {
        await saveSalary(tx, by, { employeeId: p.id, structureId: ids.structureId, ctcPaise: RAISE[p.first_name] * 100, effectiveFrom: april, reason: "revision" }, { notify: false });
      }
      // history from before erp ran payroll was paid outside erp: no arrears to settle
      await tx`update employee_salaries set arrears_from_month = null where employee_id = ${p.id}`;
      const n = String(100200300400 + i * 11);
      await saveStatutory(tx, by, p.id, { pfEnabled: ctc <= 2400000, uan: n, pfNumber: null, pfOnFullWage: false, esiEnabled: true, esiNumber: null, ptState: null, lwfState: null, taxRegime: i % 4 === 0 ? "old" : "new" });
      await saveBankAccount(tx, by, p.id, { bankName: i % 2 ? "HDFC Bank" : "State Bank of India", ifsc: i % 2 ? "HDFC0001234" : "SBIN0004321", accountNumber: String(50100000000 + i * 7919), holderName: p.first_name }, { notify: false });
    });
  }
}
