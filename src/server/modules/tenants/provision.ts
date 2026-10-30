import "server-only";
import { randomUUID } from "node:crypto";
import { sql, AppError } from "@/server/db";
import { createEmployee } from "@/server/modules/employees/service";
import { todayIn } from "@/lib/dates";
import { ensureExitDefaults } from "@/server/modules/exits/service";
import { ensureLetterDefaults } from "@/server/modules/documents/letters";

export const RESERVED = new Set(["www", "app", "api", "admin", "mail", "help", "status", "careers", "portal", "erp", "static", "docs"]);

export type Signup = { company: string; subdomain: string; firstName: string; lastName: string; email: string; password: string; employees?: number };

/**
 * New tenant with sensible defaults so the first screen already works:
 * Head office, General shift (09:30–18:30), Sat/Sun off, Casual/Sick/Earned/Unpaid leave, admin as Global admin.
 */
export async function provisionTenant(s: Signup) {
  const sub = s.subdomain.trim().toLowerCase();
  if (RESERVED.has(sub)) throw new AppError("conflict", "This address is reserved. Try another.", "subdomain");
  const [{ ok }] = await sql<{ ok: boolean }[]>`select subdomain_available(${sub}) as ok`;
  if (!ok) throw new AppError("conflict", "This address is already taken.", "subdomain");

  const tenantId = randomUUID();
  return sql.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    await tx`insert into tenants (id, subdomain, name, seats, trial_ends_at) values (${tenantId}, ${sub}, ${s.company.trim()}, ${Math.max(25, s.employees ?? 25)}, now() + interval '30 days')`;
    await tx`insert into legal_entities (tenant_id, name) values (${tenantId}, ${s.company.trim()})`;
    await tx`insert into locations (tenant_id, name) values (${tenantId}, 'Head office')`;
    for (const d of ["Management", "People", "Engineering", "Sales", "Finance", "Operations"]) await tx`insert into departments (tenant_id, name) values (${tenantId}, ${d})`;
    for (const t of ["Founder", "HR Manager", "Software Engineer", "Sales Executive", "Accountant", "Operations Associate"]) await tx`insert into designations (tenant_id, title) values (${tenantId}, ${t})`;

    await tx`insert into shifts (tenant_id, name, code, timings, break_minutes, grace_minutes, half_day_minutes) values (${tenantId}, 'General', 'GEN',
      ${tx.json(Object.fromEntries(["mon", "tue", "wed", "thu", "fri"].map((d) => [d, { start: "09:30", end: "18:30" }])))}, 60, 15, 240)`;
    await tx`insert into weekly_off_policies (tenant_id, name, pattern) values (${tenantId}, 'Saturday & Sunday', ${tx.json({ sat: "off", sun: "off" })})`;
    await tx`insert into capture_policies (tenant_id, name) values (${tenantId}, 'Default')`;
    await tx`insert into holiday_lists (tenant_id, name, year) values (${tenantId}, 'Head office', ${Number(todayIn().slice(0, 4))})`;

    const [plan] = await tx<{ id: string }[]>`insert into leave_plans (tenant_id, name, year_start, is_default) values (${tenantId}, 'Standard', 'jan', true) returning id`;
    const types = [
      { name: "Casual leave", code: "CL", kind: "regular", paid: true, color: "#2a78d6", quota: 12, app: { allowHalfDay: true, backdateDays: 7, sandwich: { enabled: false } } },
      { name: "Sick leave", code: "SL", kind: "regular", paid: true, color: "#1baf7a", quota: 8, app: { allowHalfDay: true, backdateDays: 30, attachmentAfterDays: 2 } },
      { name: "Earned leave", code: "EL", kind: "regular", paid: true, color: "#4a3aa7", quota: 15, app: { allowHalfDay: false, noticeDays: 7, backdateDays: null, sandwich: { enabled: true, ignoreHalfDays: true } } },
      { name: "Unpaid leave", code: "LWP", kind: "unpaid", paid: false, color: "#eb6834", quota: null, app: { allowHalfDay: true, backdateDays: 7 } },
    ];
    for (const t of types) {
      const [lt] = await tx<{ id: string }[]>`insert into leave_types (tenant_id, name, code, kind, is_paid, color) values (${tenantId}, ${t.name}, ${t.code}, ${t.kind}, ${t.paid}, ${t.color}) returning id`;
      await tx`insert into leave_plan_rules (tenant_id, leave_plan_id, leave_type_id, yearly_quota, application) values (${tenantId}, ${plan.id}, ${lt.id}, ${t.quota}, ${tx.json(t.app)})`;
    }

    const [ga] = await tx<{ id: string }[]>`insert into roles (tenant_id, key, name, is_system, permissions) values (${tenantId}, 'global_admin', 'Global admin', true, ${["*"]}) returning id`;
    await tx`insert into roles (tenant_id, key, name, is_system, permissions) values (${tenantId}, 'hr_admin', 'HR admin', true,
      ${["employees.read", "employees.write", "leave.admin", "attendance.admin", "approvals.override", "reports.read", "settings.org", "exits.manage", "documents.manage"]})`;
    await tx`insert into approval_workflows (tenant_id, entity_type, name, levels) values (${tenantId}, 'leave', 'Leave: reporting manager', ${tx.json([{ approver: "manager" }])})`;
    await tx`insert into approval_workflows (tenant_id, entity_type, name, levels) values (${tenantId}, 'attendance_request', 'Attendance: reporting manager', ${tx.json([{ approver: "manager" }])})`;

    await ensureExitDefaults(tx, tenantId);     // notice periods 30/60/90, exit reasons, exit checklist
    await ensureLetterDefaults(tx, tenantId);   // relieving + experience letter templates

    const [founder] = await tx<{ id: string }[]>`select id from designations where title = 'Founder'`;
    const [mgmt] = await tx<{ id: string }[]>`select id from departments where name = 'Management'`;
    const admin = await createEmployee(tx, tenantId, {
      firstName: s.firstName, lastName: s.lastName, workEmail: s.email, password: s.password,
      joiningDate: todayIn(), designationId: founder.id, departmentId: mgmt.id,
    }, null);
    await tx`insert into role_assignments (tenant_id, role_id, employee_id) values (${tenantId}, ${ga.id}, ${admin.employeeId})`;
    return { tenantId, subdomain: sub, userId: admin.userId };
  });
}
