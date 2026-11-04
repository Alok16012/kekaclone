/**
 * Demo tenant for local development: http://acme.localhost:3100
 * Every seeded person signs in with DEMO_PASSWORD (test value, local only). Re-running drops and recreates the tenant.
 *   pnpm db:seed
 */
import postgres from "postgres";
import { provisionTenant } from "@/server/modules/tenants/provision";
import { createEmployee } from "@/server/modules/employees/service";
import * as leave from "@/server/modules/leave/service";
import { decide } from "@/server/modules/approvals/service";
import { recomputeDay } from "@/server/modules/attendance/service";
import { withTenant, sql } from "@/server/db";
import { hashPassword } from "@/server/auth/password";
import { addDaysISO, todayIn, weekday } from "@/lib/dates";
import type { Actor } from "@/server/auth/session";

import { DEMO_PASSWORD, DEMO_SUBDOMAIN } from "./demo";

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} });

const PEOPLE = [
  // [first, last, designation, department, manager first name]
  ["Rohan", "Mehta", "Software Engineer", "Engineering", "Asha"],
  ["Priya", "Nair", "HR Manager", "People", "Asha"],
  ["Karan", "Singh", "Accountant", "Finance", "Asha"],
  ["Arjun", "Rao", "Software Engineer", "Engineering", "Rohan"],
  ["Meera", "Iyer", "Software Engineer", "Engineering", "Rohan"],
  ["Vikram", "Joshi", "Software Engineer", "Engineering", "Rohan"],
  ["Sneha", "Kulkarni", "Sales Executive", "Sales", "Asha"],
  ["Imran", "Khan", "Sales Executive", "Sales", "Sneha"],
  ["Divya", "Pillai", "Operations Associate", "Operations", "Priya"],
  ["Aditya", "Bhattacharya-Raghunathan", "Operations Associate", "Operations", "Priya"],   // long name on purpose
  ["Fatima", "Sheikh", "Accountant", "Finance", "Karan"],
] as const;

async function main() {
  await admin`delete from tenants where subdomain = ${DEMO_SUBDOMAIN}`;
  const today = todayIn();
  const { tenantId } = await provisionTenant({ company: "Acme Technologies", subdomain: DEMO_SUBDOMAIN, firstName: "Asha", lastName: "Verma", email: "asha@acme.test", password: DEMO_PASSWORD });

  const ids: Record<string, string> = {};
  await withTenant(tenantId, async (tx) => {
    const [me] = await tx<{ id: string }[]>`select id from employees where work_email = 'asha@acme.test'`;
    ids.Asha = me.id;
    const pw = await hashPassword(DEMO_PASSWORD);
    const joinYear = Number(today.slice(0, 4)) - 1;
    for (const [i, [first, last, title, dept, mgr]] of PEOPLE.entries()) {
      const [d] = await tx<{ id: string }[]>`select id from designations where title = ${title}`;
      const [dp] = await tx<{ id: string }[]>`select id from departments where name = ${dept}`;
      const e = await createEmployee(tx, tenantId, {
        firstName: first, lastName: last, workEmail: `${first.toLowerCase()}@acme.test`, password: DEMO_PASSWORD,
        joiningDate: `${joinYear}-${String((i % 12) + 1).padStart(2, "0")}-01`, designationId: d.id, departmentId: dp.id, managerId: ids[mgr],
      }, null);
      ids[first] = e.employeeId;
      await tx`update users set password_hash = ${pw} where id = ${e.userId}`;
    }
    // Priya is HR admin
    await tx`insert into role_assignments (tenant_id, role_id, employee_id) select ${tenantId}, id, ${ids.Priya} from roles where key = 'hr_admin'`;
    // a public holiday next month for the calendar
    const nextMonth = addDaysISO(today, 20);
    await tx`insert into holidays (tenant_id, holiday_list_id, name, date) select ${tenantId}, id, 'Company day off', ${nextMonth} from holiday_lists limit 1`;
  });

  const actorFor = async (first: string): Promise<Actor> => {
    const [u] = await withTenant(tenantId, (tx) => tx<{ user_id: string; display_name: string }[]>`select user_id, display_name from employees where id = ${ids[first]}`);
    return { tenant: { id: tenantId, name: "Acme Technologies", status: "trial", subdomain: DEMO_SUBDOMAIN }, userId: u.user_id, employeeId: ids[first], name: u.display_name, email: "", title: null, roles: [], permissions: new Set(), grants: [] };
  };
  const nextWorking = (from: string) => { let d = from; while (["sat", "sun"].includes(weekday(d))) d = addDaysISO(d, 1); return d; };
  const casual = await withTenant(tenantId, (tx) => tx<{ id: string }[]>`select id from leave_types where code = 'CL'`).then((r) => r[0].id);
  const sick = await withTenant(tenantId, (tx) => tx<{ id: string }[]>`select id from leave_types where code = 'SL'`).then((r) => r[0].id);

  // pending for Asha to approve, pending for Rohan to approve, one approved today, one approved later
  const apply = async (who: string, typeId: string, from: string, to: string, note?: string) => {
    const actor = await actorFor(who);
    return withTenant(tenantId, (tx) => leave.apply(tx, actor, { leaveTypeId: typeId, from, to, fromPart: "full", toPart: "full", note }));
  };
  const d1 = nextWorking(addDaysISO(today, 6));
  await apply("Sneha", casual, d1, nextWorking(addDaysISO(d1, 1)), "Cousin's wedding in Pune");
  await apply("Karan", casual, nextWorking(addDaysISO(today, 9)), nextWorking(addDaysISO(today, 9)));
  await apply("Arjun", casual, nextWorking(addDaysISO(today, 12)), nextWorking(addDaysISO(today, 12)), "Personal work");
  const t = nextWorking(today);
  const r = await apply("Meera", sick, t, t, "Fever");
  const rohan = await actorFor("Rohan");
  await withTenant(tenantId, async (tx) => {
    const [step] = await tx<{ id: string }[]>`select s.id from approval_steps s join approval_requests q on q.id = s.request_id where q.entity_id = ${r.id} and s.status = 'pending'`;
    await decide(tx, rohan, step.id, "approved", "Get well soon");
  });

  // two weeks of attendance for everyone (09:2x–18:4x IST on working days)
  await withTenant(tenantId, async (tx) => {
    for (const [name, id] of Object.entries(ids)) {
      for (let back = 14; back >= 1; back--) {
        const day = addDaysISO(today, -back);
        if (["sat", "sun"].includes(weekday(day))) continue;
        const seed = (name.length * 7 + back * 13) % 40;
        const inAt = new Date(`${day}T09:${String(10 + (seed % 35)).padStart(2, "0")}:00+05:30`);
        const outAt = new Date(`${day}T18:${String(20 + (seed % 30)).padStart(2, "0")}:00+05:30`);
        await tx`insert into punches (tenant_id, employee_id, at, direction, source) values (${tenantId}, ${id}, ${inAt}, 'in', 'web'), (${tenantId}, ${id}, ${outAt}, 'out', 'web')`;
        await recomputeDay(tx, tenantId, id, day);
      }
    }
  });
  await (await import("./seed-platform")).seedPlatform(tenantId);
  await (await import("./seed-leave")).seedLeave(tenantId);
  await (await import("./seed-attendance")).seedAttendance(tenantId);
  await (await import("./seed-exitdocs")).seedExitDocs(tenantId);
  await (await import("./seed-engage")).seedEngage(tenantId);
  await (await import("./seed-statutory")).seedStatutory(tenantId);
  await (await import("./seed-payfoundation")).seedPayFoundation(tenantId);
  await (await import("./seed-expenses")).seedExpenses(tenantId);
  await (await import("./seed-servicedesk")).seedServiceDesk(tenantId);
  await (await import("./seed-payrun")).seedPayrun(tenantId);
  await (await import("./seed-taxloans")).seedTaxLoans(tenantId);
  await (await import("./seed-corehr")).seedCoreHr(tenantId);
  await (await import("./seed-saas")).seedSaas(tenantId);
  await (await import("./seed-time2")).seedTime2(tenantId);
  await (await import("./seed-onboarding")).seedOnboarding(tenantId);
  await (await import("./seed-hire")).seedHire(tenantId);
  await (await import("./seed-performance")).seedPerformance(tenantId);
  await (await import("./seed-workspace")).seedWorkspace(tenantId);
  await (await import("./seed-hp2")).seedHp2(tenantId);
  console.log(`Seeded http://${DEMO_SUBDOMAIN}.${process.env.ROOT_DOMAIN} — ${Object.keys(ids).length} people. Password for every account is in db/demo.ts (DEMO_PASSWORD).`);
  await admin.end(); await sql.end();
}

main().catch(async (e) => { console.error(e); await admin.end(); await sql.end(); process.exit(1); });
