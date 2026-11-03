/**
 * Demo data for projects / timesheets, Learn and Reports on the seeded tenant (called from db/seed.ts):
 * two clients, four projects (T&M, retainer, fixed-price with milestones, internal), three weeks of timesheets in every state,
 * one invoice from approved hours; three courses (one draft) with assignment rules and learners at different stages
 * (one certificate issued, one overdue); a shared saved report and a scheduled one.
 */
import { withTenant } from "@/server/db";
import * as psa from "@/server/modules/psa/service";
import * as learn from "@/server/modules/learn/service";
import * as reports from "@/server/modules/reports/service";
import { weekStartOf, type GridRow } from "@/server/modules/psa/rules";
import { decide } from "@/server/modules/approvals/service";
import type { Actor } from "@/server/auth/session";
import { addDaysISO, todayIn } from "@/lib/dates";

export async function seedWorkspace(tenantId: string) {
  const tenant = { id: tenantId, name: "Acme Technologies", status: "trial", subdomain: "acme" };
  const actor = async (first: string, permissions: string[] = []): Promise<Actor> => {
    const [e] = await withTenant(tenantId, (tx) => tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`);
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(permissions), grants: permissions.length ? [{ permissions, scopes: [] }] : [] };
  };
  const asha = await actor("Asha", ["*"]), priya = await actor("Priya", ["psa.admin", "psa.billing", "learn.admin", "reports.read", "reports.build"]);
  const karan = await actor("Karan", ["psa.billing", "reports.read", "reports.build"]);
  const [rohan, arjun, meera, vikram, divya, sneha] = await Promise.all(["Rohan", "Arjun", "Meera", "Vikram", "Divya", "Sneha"].map((n) => actor(n)));
  const today = todayIn();
  const thisWeek = weekStartOf(today);

  // ---------- roles ----------
  await withTenant(tenantId, async (tx) => {
    await tx`update roles set permissions = (select array_agg(distinct p) from unnest(permissions || ${["psa.admin", "psa.billing", "learn.admin", "reports.build"]}::text[]) p) where key = 'hr_admin'`;
    await tx`update roles set permissions = (select array_agg(distinct p) from unnest(permissions || ${["psa.billing", "reports.read", "reports.build"]}::text[]) p) where key = 'finance'`;
    await tx`insert into roles (tenant_id, key, name, is_system, permissions) values (${tenantId}, 'project_manager', 'Project manager', false, ${["psa.admin"]}) on conflict (tenant_id, key) do nothing`;
    await tx`insert into role_assignments (tenant_id, role_id, employee_id) select ${tenantId}, id, ${rohan.employeeId} from roles where key = 'project_manager'`;
    await psa.savePolicy(tx, priya, { cadence: "weekly", min_minutes_per_day: 0, min_minutes_per_week: 0, max_minutes_per_day: 720, lock_after_days: 45, approver: "project", allow_future: false, require_note: false });
  });

  // ---------- clients + projects ----------
  const ids = await withTenant(tenantId, async (tx) => {
    const nw = await psa.saveClient(tx, priya, null, { name: "Northwind Retail", gstin: "27AABCU9603R1ZX", currency: "INR", address: { line1: "4th floor, Trade Centre", city: "Mumbai", state: "Maharashtra", pincode: "400051", email: "accounts@northwind.example" } });
    const gx = await psa.saveClient(tx, priya, null, { name: "Globex Logistics", gstin: null, currency: "INR", address: { line1: "Plot 12, Industrial Area", city: "Pune", state: "Maharashtra", pincode: "411014" } });
    const store = await psa.saveProject(tx, priya, null, { name: "Northwind Storefront", code: "NWS", clientId: nw.id, billingModel: "time_and_materials", retainerPaise: null, currency: "INR", startDate: addDaysISO(today, -90), endDate: addDaysISO(today, 120),
      description: "Rebuild of the Northwind online store: catalogue, cart and checkout.", approverIds: [rohan.employeeId], budgetMinutes: 1200 * 60 });
    const retainer = await psa.saveProject(tx, priya, null, { name: "Globex platform support", code: "GXS", clientId: gx.id, billingModel: "retainer", retainerPaise: 15000000, currency: "INR", startDate: addDaysISO(today, -200), endDate: null,
      description: "Monthly support retainer: incidents, patches and small changes.", approverIds: [asha.employeeId], budgetMinutes: null });
    const revamp = await psa.saveProject(tx, priya, null, { name: "Globex website revamp", code: "GXW", clientId: gx.id, billingModel: "fixed", retainerPaise: null, currency: "INR", startDate: addDaysISO(today, -60), endDate: addDaysISO(today, 60),
      description: "Fixed-price redesign in three milestones.", approverIds: [rohan.employeeId], budgetMinutes: null });
    const internal = await psa.saveProject(tx, priya, null, { name: "Internal tooling", code: "INT", clientId: null, billingModel: "non_billable", retainerPaise: null, currency: "INR", startDate: null, endDate: null,
      description: "Our own dashboards, scripts and meetings.", approverIds: [], budgetMinutes: null });

    for (const [pid, eid, role, rate, alloc] of [
      [store.id, arjun.employeeId, "Backend engineer", 250000, 80], [store.id, meera.employeeId, "Frontend engineer", 250000, 60], [store.id, vikram.employeeId, "QA", null, 40], [store.id, rohan.employeeId, "Tech lead", 350000, 20],
      [retainer.id, rohan.employeeId, "Lead", 350000, 20], [retainer.id, arjun.employeeId, "Engineer", 250000, 20],
      [revamp.id, meera.employeeId, "Designer-developer", 250000, 40],
      [internal.id, arjun.employeeId, null, null, null], [internal.id, meera.employeeId, null, null, null], [internal.id, vikram.employeeId, null, null, null], [internal.id, rohan.employeeId, null, null, null],
    ] as const) await psa.saveMember(tx, priya, pid, { employeeId: eid, role, billRatePaise: rate, allocationPct: alloc });

    const t = async (pid: string, name: string, billable: boolean, phase: string | null) => (await psa.saveTask(tx, priya, pid, null, { name, isBillable: billable, phase, startDate: null, endDate: null })).id;
    const api = await t(store.id, "Catalogue API", true, "Build"), ui = await t(store.id, "Checkout UI", true, "Build"), disc = await t(store.id, "Discovery workshops", true, "Discovery"), meet = await t(store.id, "Stand-ups and planning", false, null);
    const inc = await t(retainer.id, "Incidents", true, null), patch = await t(retainer.id, "Patches", true, null);
    const design = await t(revamp.id, "Design", true, "Design"), build = await t(revamp.id, "Build", true, "Build");
    const tooling = await t(internal.id, "Dashboards", false, null), allhands = await t(internal.id, "All-hands and 1:1s", false, null);
    await psa.saveMilestone(tx, priya, revamp.id, null, { name: "Design signed off", phase: "Design", dueDate: addDaysISO(today, -20), amountPaise: 20000000, status: "done" });
    await psa.saveMilestone(tx, priya, revamp.id, null, { name: "Build complete", phase: "Build", dueDate: addDaysISO(today, 30), amountPaise: 50000000, status: "planned" });
    await psa.saveMilestone(tx, priya, revamp.id, null, { name: "Launch", phase: "Launch", dueDate: addDaysISO(today, 60), amountPaise: 10000000, status: "planned" });
    return { nw: nw.id, gx: gx.id, store: store.id, retainer: retainer.id, revamp: revamp.id, internal: internal.id, api, ui, disc, meet, inc, patch, design, build, tooling, allhands };
  });

  // ---------- timesheets: three weeks back, every state ----------
  const row = (projectId: string, taskId: string | null, billable: boolean, note: string, minutes: number[]): GridRow => ({ projectId, taskId, billable, note, minutes });
  const w1 = addDaysISO(thisWeek, -21), w2 = addDaysISO(thisWeek, -14), w3 = addDaysISO(thisWeek, -7);
  const approveFor = async (who: Actor, approver: Actor, comment: string) => withTenant(tenantId, async (tx) => {
    const steps = await tx<{ id: string }[]>`select s.id from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_type = 'timesheet' and r.requester_employee_id = ${who.employeeId} and s.approver_employee_id = ${approver.employeeId} and s.status = 'pending'`;
    for (const s of steps) await decide(tx, approver, s.id, "approved", comment);
  });
  for (const week of [w1, w2]) {
    await withTenant(tenantId, (tx) => psa.submitWeek(tx, arjun, week, [row(ids.store, ids.api, true, "Catalogue endpoints and tests", [420, 450, 480, 390, 420, 0, 0]), row(ids.store, ids.meet, false, "", [60, 30, 30, 60, 30, 0, 0]), row(ids.internal, ids.allhands, false, "", [0, 0, 0, 0, 60, 0, 0])], today));
    await withTenant(tenantId, (tx) => psa.submitWeek(tx, meera, week, [row(ids.store, ids.ui, true, "Cart and checkout screens", [300, 360, 300, 360, 240, 0, 0]), row(ids.revamp, ids.design, true, "Homepage concepts", [180, 120, 180, 120, 180, 0, 0])], today));
    await approveFor(arjun, rohan, "Looks right");
    await approveFor(meera, rohan, "");
  }
  // last week: Arjun approved, Meera waiting for Rohan, Vikram sent back once and resubmitted
  await withTenant(tenantId, (tx) => psa.submitWeek(tx, arjun, w3, [row(ids.store, ids.api, true, "Search and filters", [480, 480, 420, 480, 420, 0, 0]), row(ids.retainer, ids.inc, true, "P1 incident on Tuesday", [0, 120, 0, 0, 0, 0, 0])], today));
  await approveFor(arjun, rohan, "");
  await withTenant(tenantId, (tx) => psa.submitWeek(tx, meera, w3, [row(ids.store, ids.ui, true, "Payment page", [420, 420, 420, 420, 300, 0, 0]), row(ids.internal, ids.tooling, false, "Release dashboard", [60, 60, 60, 60, 60, 0, 0])], today));
  await withTenant(tenantId, (tx) => psa.submitWeek(tx, vikram, w3, [row(ids.store, ids.ui, false, "Regression run", [480, 480, 480, 480, 480, 0, 0])], today));
  await withTenant(tenantId, async (tx) => {
    const [s] = await tx<{ id: string }[]>`select s.id from approval_steps s join approval_requests r on r.id = s.request_id where r.entity_type = 'timesheet' and r.requester_employee_id = ${vikram.employeeId} and s.status = 'pending'`;
    await decide(tx, rohan, s.id, "rejected", "Please log the QA hours against the right task and mark them billable.");
  });
  await withTenant(tenantId, (tx) => psa.submitWeek(tx, vikram, w3, [row(ids.store, ids.ui, true, "Regression run on checkout", [480, 480, 480, 480, 480, 0, 0])], today));
  // this week: drafts in progress
  const dayIdx = Math.max(0, Math.min(6, (new Date(today + "T00:00:00Z").getUTCDay() + 6) % 7));
  const soFar = (m: number) => Array.from({ length: 7 }, (_, i) => (i < dayIdx && i < 5 ? m : 0));
  await withTenant(tenantId, (tx) => psa.saveWeek(tx, arjun, thisWeek, [row(ids.store, ids.api, true, "Order history API", soFar(450))], today));
  await withTenant(tenantId, (tx) => psa.saveWeek(tx, rohan, thisWeek, [row(ids.retainer, ids.patch, true, "Security patch rollout", soFar(120)), row(ids.store, ids.disc, true, "", soFar(90))], today));

  // ---------- invoice from the first approved week ----------
  await withTenant(tenantId, async (tx) => {
    const inv = await psa.createInvoice(tx, karan, { projectId: ids.store, from: w1, to: addDaysISO(w1, 6), taxRateBp: 1800, milestoneIds: [], notes: "Payable within 15 days by bank transfer.", dueInDays: 15 });
    await psa.setInvoiceStatus(tx, karan, inv.id, "sent");
    const ms = await psa.createInvoice(tx, karan, { projectId: ids.revamp, from: addDaysISO(today, -60), to: today, taxRateBp: 1800, milestoneIds: [], notes: null, dueInDays: 30 });
    await psa.setInvoiceStatus(tx, karan, ms.id, "sent");
    await psa.setInvoiceStatus(tx, karan, ms.id, "paid");
  });

  // ---------- Learn ----------
  const courses = await withTenant(tenantId, async (tx) => {
    const coc = await learn.saveCourse(tx, priya, null, { title: "Code of conduct and workplace safety", description: "What we expect from each other at Acme: respect, integrity, speaking up, and the POSH policy.", certificate: true, estimatedMinutes: 40 });
    await learn.saveModule(tx, priya, coc.id, null, { title: "Welcome from the founder", kind: "video", content: { url: "https://www.youtube.com/watch?v=ysz5S6PUM-U" }, file: null });
    await learn.saveModule(tx, priya, coc.id, null, { title: "Our code of conduct", kind: "text", file: null, content: { html: "<h2>Respect at work</h2><p>Everyone at Acme deserves a workplace free of harassment and discrimination. Treat colleagues, clients and vendors with courtesy.</p><h3>Speaking up</h3><p>If you see something wrong, raise it with your manager, HR, or through the helpdesk. Retaliation against anyone who speaks up is itself a breach of this code.</p><ul><li>Keep company and client information confidential.</li><li>Declare conflicts of interest.</li><li>Never offer or accept gifts above Rs. 2,000 without approval.</li></ul>" } });
    await learn.saveModule(tx, priya, coc.id, null, { title: "POSH policy", kind: "link", content: { url: "https://www.india.gov.in/" }, file: null });
    await learn.saveModule(tx, priya, coc.id, null, { title: "Check your understanding", kind: "quiz", file: null, content: { pass_pct: 70, questions: [
      { id: "q1", text: "A colleague keeps making jokes that make someone uncomfortable. What should you do?", options: ["Ignore it; it's just banter", "Raise it with your manager or HR", "Post about it on the wall"], correct: 1 },
      { id: "q2", text: "A vendor offers you a Rs. 5,000 gift card. You should…", options: ["Accept it quietly", "Declare it and get approval first", "Share it with the team"], correct: 1 },
      { id: "q3", text: "Who can file a POSH complaint?", options: ["Only permanent employees", "Anyone at the workplace, including contractors and interns", "Only women on the payroll"], correct: 1 },
    ] } });
    await learn.setCourseStatus(tx, priya, coc.id, "published");

    const sec = await learn.saveCourse(tx, priya, null, { title: "Information security basics", description: "Passwords, phishing, devices and data handling for everyone who uses a laptop.", certificate: true, estimatedMinutes: 25 });
    await learn.saveModule(tx, priya, sec.id, null, { title: "Passwords and sign-in codes", kind: "text", file: null, content: { html: "<p>Use a password manager, never reuse passwords, and keep sign-in codes to yourself. erp will never ask for your code by chat or email.</p>" } });
    await learn.saveModule(tx, priya, sec.id, null, { title: "Spotting phishing", kind: "video", content: { url: "https://vimeo.com/76979871" }, file: null });
    await learn.saveModule(tx, priya, sec.id, null, { title: "Security quiz", kind: "quiz", file: null, content: { pass_pct: 60, questions: [
      { id: "q1", text: "An email from 'IT' asks for your password to 'verify your account'. You…", options: ["Reply with it", "Report it as phishing", "Forward it to a colleague"], correct: 1 },
      { id: "q2", text: "Your laptop is lost. First step?", options: ["Buy a new one", "Tell IT / helpdesk immediately", "Wait a week in case it turns up"], correct: 1 },
    ] } });
    await learn.setCourseStatus(tx, priya, sec.id, "published");

    const mgr = await learn.saveCourse(tx, priya, null, { title: "Manager essentials", description: "Running 1:1s, giving feedback and approving leave and timesheets fairly.", certificate: false, estimatedMinutes: 90 });
    await learn.saveModule(tx, priya, mgr.id, null, { title: "Running a good 1:1", kind: "text", file: null, content: { html: "<p>Draft: notes for the first module.</p>" } });

    await learn.saveAssignment(tx, priya, coc.id, null, { name: "Everyone, yearly", rule: { kind: "everyone" }, dueInDays: 30, reminderDaysBefore: 5, isActive: true });
    const [eng] = await tx<{ id: string }[]>`select id from departments where name = 'Engineering'`;
    await learn.saveAssignment(tx, priya, sec.id, null, { name: "Engineering", rule: { kind: "departments", ids: [eng.id] }, dueInDays: 21, reminderDaysBefore: 3, isActive: true });
    await learn.saveAssignment(tx, priya, sec.id, null, { name: "New joiners (first 90 days)", rule: { kind: "new_joiners", within_days: 90 }, dueInDays: 14, reminderDaysBefore: 3, isActive: true });
    return { coc, sec, mgr };
  });
  // learners at different stages
  await withTenant(tenantId, async (tx) => {
    const mods = (await tx<{ id: string; kind: string }[]>`select id, kind from course_modules where course_id = ${courses.coc.id} order by position`);
    for (const m of mods) {
      if (m.kind === "quiz") await learn.submitQuiz(tx, arjun, courses.coc.id, m.id, [1, 1, 1]);
      else await learn.completeModule(tx, arjun, courses.coc.id, m.id);
    }
    await learn.completeModule(tx, meera, courses.coc.id, mods[0].id);
    await learn.completeModule(tx, meera, courses.coc.id, mods[1].id);
    await learn.submitQuiz(tx, meera, courses.coc.id, mods[3].id, [0, 1, 0]);   // failed attempt, will retry
    await learn.completeModule(tx, rohan, courses.coc.id, mods[0].id);
    const sec = (await tx<{ id: string; kind: string }[]>`select id, kind from course_modules where course_id = ${courses.sec.id} order by position`);
    await learn.completeModule(tx, vikram, courses.sec.id, sec[0].id);
    // Divya is late on the conduct course; Sneha got it long ago and has an overdue reminder pending
    await tx`update enrollments set due_date = ${addDaysISO(today, -6)}, created_at = now() - interval '36 days' where employee_id in (${divya.employeeId}, ${sneha.employeeId}) and course_id = ${courses.coc.id}`;
  });

  // ---------- Reports ----------
  await withTenant(tenantId, async (tx) => {
    const r1 = await reports.saveReport(tx, priya, null, { name: "Engineering leave this year", dataset: "leave_requests", sharedRoles: ["hr_admin", "project_manager"],
      definition: { columns: ["name", "type", "from_date", "to_date", "days", "status"], filters: [{ col: "department", op: "eq", value: "Engineering" }, { col: "from_date", op: "gte", value: `${today.slice(0, 4)}-01-01` }], sort: { col: "from_date", dir: "desc" } } });
    await reports.saveReport(tx, priya, null, { name: "Hours by project (approved)", dataset: "time_entries", sharedRoles: ["finance"],
      definition: { groupBy: "project", aggregates: [{ fn: "sum", col: "hours" }, { fn: "count" }], filters: [{ col: "timesheet_status", op: "eq", value: "approved" }], sort: { col: "sum_hours", dir: "desc" } } });
    const r3 = await reports.saveReport(tx, karan, null, { name: "Expense claims above Rs. 5,000", dataset: "expense_claims", sharedRoles: [],
      definition: { columns: ["claim_number", "submitted_at", "name", "department", "title", "total", "status"], filters: [{ col: "total", op: "gte", value: 5000 }], sort: { col: "total", dir: "desc" } } });
    await reports.setSchedule(tx, karan, r3.id, { frequency: "weekly", weekday: 1, hour: 9, recipients: [asha.employeeId, karan.employeeId], format: "xlsx" });
    void r1;
  });
}
