/**
 * Demo content for onboarding, surveys and Home extras on the acme tenant: called at the end of db/seed.ts.
 * Three new joiners (one starting next week in preboarding, one who joined this week with onboarding under way and an
 * overdue task, one not started yet), an Engineering checklist, quick links, two people remote today, a live anonymous
 * pulse with enough answers to show results, and a scheduled check-in survey.
 */
import { withTenant, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import type { Scope } from "@/server/auth/catalog";
import { addDaysISO, todayIn } from "@/lib/dates";
import { createEmployee } from "@/server/modules/employees/service";
import { ensurePayrollDefaults } from "@/server/modules/payroll/defaults";
import { saveSalary } from "@/server/modules/payroll/salary";
import * as ob from "@/server/modules/onboarding/service";
import * as sv from "@/server/modules/surveys/service";
import * as home from "@/server/modules/home/service";

export async function seedOnboarding(tenantId: string) {
  const today = todayIn();
  const tenant = { id: tenantId, name: "Acme Technologies", status: "trial", subdomain: "acme" };
  const actorIn = async (tx: Tx, first: string): Promise<Actor> => {
    const [e] = await tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`;
    const roles = await tx<{ key: string; permissions: string[]; scopes: Scope[] }[]>`select r.key, r.permissions, ra.scopes from role_assignments ra join roles r on r.id = ra.role_id where ra.employee_id = ${e.id}`;
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: roles.map((r) => r.key),
      permissions: new Set(roles.flatMap((r) => r.permissions)), grants: roles.map((r) => ({ permissions: r.permissions, scopes: r.scopes ?? [] })) };
  };

  await withTenant(tenantId, async (tx) => {
    // HR admins run onboarding and surveys (new companies get this when they're provisioned)
    await tx`update roles set permissions = array(select distinct unnest(permissions || array['onboarding.manage', 'surveys.manage'])) where key = 'hr_admin'`;
    const [asha, priya, karan] = await Promise.all(["Asha", "Priya", "Karan"].map((n) => actorIn(tx, n)));
    const dept = async (name: string) => (await tx<{ id: string }[]>`select id from departments where name = ${name}`)[0]?.id ?? null;
    const person = async (first: string) => (await tx<{ id: string }[]>`select id from employees where first_name = ${first}`)[0].id;
    const [eng, sales, fin] = await Promise.all([dept("Engineering"), dept("Sales"), dept("Finance")]);

    // checklists: the standard one plus an Engineering one with a buddy and a dev-setup task
    await ob.ensureOnboardingDefaults(tx, tenantId);
    const engTpl = await ob.saveTemplate(tx, asha, null, { name: "Engineering onboarding", criteria: eng ? { department_ids: [eng] } : {} });
    const meera = await person("Meera");
    const items = [
      { title: "Share your personal email", type: "profile_field" as const, owner: { type: "self" as const }, dueOffsetDays: -3, config: { field: "personal_email" as const } },
      { title: "Upload your PAN card", type: "document_upload" as const, owner: { type: "self" as const }, dueOffsetDays: 0, config: { docType: "PAN card", category: "identity" as const } },
      { title: "Read the engineering handbook", type: "acknowledge" as const, owner: { type: "self" as const }, dueOffsetDays: 3, config: { ackText: "I have read the engineering handbook, including the code review and on-call guidelines." } },
      { title: "Order laptop and accounts", type: "simple" as const, owner: { type: "role" as const, role: "global_admin" }, dueOffsetDays: -2 },
      { title: "Set up the development environment", description: "Repository access, local setup and a first small change merged.", type: "simple" as const, owner: { type: "manager" as const }, dueOffsetDays: 2 },
      { title: "Be their buddy for the first month", type: "simple" as const, owner: { type: "employee" as const, id: meera }, dueOffsetDays: 1 },
      { title: "Approve probation goals", type: "approval" as const, owner: { type: "role" as const, role: "hr_admin" }, dueOffsetDays: 14 },
    ];
    for (const it of items) await ob.saveItem(tx, asha, engTpl.id, null, it);

    // three joiners, each with a CTC (every working person has one)
    const pay = await ensurePayrollDefaults(tx, tenantId);
    const join = async (first: string, last: string, departmentId: string | null, manager: string, joining: string, preboarding: boolean, ctc: number) => {
      const e = await createEmployee(tx, tenantId, { firstName: first, lastName: last, workEmail: `${first.toLowerCase()}.${last.toLowerCase()}@acme.test`, joiningDate: joining, departmentId, managerId: await person(manager) }, asha.userId);
      if (preboarding) await tx`update employees set status = 'preboarding' where id = ${e.employeeId}`;
      if (pay?.structureId) await saveSalary(tx, karan, { employeeId: e.employeeId, structureId: pay.structureId, ctcPaise: ctc * 100, effectiveFrom: joining, reason: "joining" }, { notify: false });
      return e.employeeId;
    };
    const kavya = await join("Kavya", "Nair", eng, "Vikram", addDaysISO(today, 7), true, 14_00_000);
    const rahul = await join("Rahul", "Mehta", sales, "Aditya", addDaysISO(today, -4), false, 8_00_000);
    await join("Neha", "Kapoor", fin, "Fatima", addDaysISO(today, 14), true, 9_50_000);
    await tx`update employees set personal_email = 'kavya.nair@example.com' where id = ${kavya}`;

    await ob.startOnboarding(tx, kavya, { actorUserId: priya.userId });
    const r = await ob.startOnboarding(tx, rahul, { actorUserId: priya.userId });
    // Rahul: shared his email and read the handbook; his manager (Aditya) planned the first week. The laptop task is overdue.
    const rahulActor = await actorIn(tx, "Rahul");
    const aditya_ = await actorIn(tx, "Aditya");
    const tasks = await tx<{ id: string; title: string }[]>`select id, title from tasks where process_id = ${r.processId}`;
    const t = (title: string) => tasks.find((x) => x.title === title)!.id;
    await ob.completeTask(tx, rahulActor, t("Share your personal email"), { kind: "field", value: "rahul.mehta@example.com" });
    await ob.completeTask(tx, rahulActor, t("Read the employee handbook"), { kind: "acknowledge" });
    await ob.completeTask(tx, aditya_, t("Plan the first week"), { kind: "done" });

    // Home: quick links and two people remote today
    for (const l of [
      { label: "Employee handbook", url: "https://handbook.acme.example/" }, { label: "IT service portal", url: "https://it.acme.example/" },
      { label: "Travel desk", url: "https://travel.acme.example/" }, { label: "Health insurance", url: "https://insurer.example/acme" },
      { label: "Learning library", url: "https://learn.acme.example/" },
    ]) await home.saveQuickLink(tx, asha, null, l);
    const [imran, aditya] = await Promise.all([person("Imran"), person("Aditya")]);
    await tx`insert into attendance_requests (tenant_id, employee_id, kind, from_date, to_date, payload, reason, status)
      values (${tenantId}, ${imran}, 'wfh', ${today}, ${today}, ${tx.json({ half: null })}, 'Plumber visiting at home', 'approved'),
             (${tenantId}, ${aditya}, 'on_duty', ${today}, ${today}, ${tx.json({ half: null })}, 'Vendor site visit', 'approved')`;

    // surveys: a live anonymous pulse with enough answers to show, and a check-in scheduled for later this week
    const pulse = await sv.createFromStarter(tx, priya, "enps");
    await sv.launchSurvey(tx, priya, pulse.id, today);
    const qs = await tx<{ id: string; type: string }[]>`select id, type from survey_questions where survey_id = ${pulse.id} order by position`;
    const answers: [string, number, number, number, string | null][] = [
      ["Arjun", 9, 4, 5, "More pairing sessions across teams."], ["Meera", 10, 5, 4, null], ["Vikram", 7, 3, 3, "Clearer priorities each sprint."],
      ["Sneha", 8, 4, 4, null], ["Imran", 6, 2, 3, "Faster laptop replacements."], ["Aditya", 9, 5, 5, "Keep the Friday demos!"],
    ];
    for (const [first, nps, a, b, text] of answers) {
      const who = await actorIn(tx, first);
      const vals: Record<string, string | number | null> = {};
      qs.forEach((q, i) => { vals[q.id] = [nps, a, b, text][i] ?? null; });
      await sv.submitResponse(tx, who, pulse.id, vals);
    }
    const check = await sv.createFromStarter(tx, priya, "joiner");
    await sv.saveSurvey(tx, priya, check.id, { title: "First month check-in", description: "For people who joined recently.", anonymous: false, minResponses: 5, audience: { type: "org" }, startOn: addDaysISO(today, 3), endOn: addDaysISO(today, 17), recurrence: "none" }, today);
  });
}
