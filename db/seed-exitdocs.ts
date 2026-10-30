/**
 * Demo data for exits + documents on the seeded tenant (called from db/seed.ts):
 * notice periods, folders with policies (one needs acknowledgement, one blocks Sales until acknowledged),
 * letter templates, Imran's resignation waiting for approval, Divya serving notice, Nikhil already exited.
 */
import { withTenant } from "@/server/db";
import { createEmployee } from "@/server/modules/employees/service";
import * as exits from "@/server/modules/exits/service";
import * as docs from "@/server/modules/documents/service";
import { ensureLetterDefaults, generateLetter } from "@/server/modules/documents/letters";
import { renderLetterPdf } from "@/server/modules/documents/pdf";
import { addDaysISO, todayIn } from "@/lib/dates";
import type { Actor } from "@/server/auth/session";

export async function seedExitDocs(tenantId: string) {
  const today = todayIn();
  const tenant = { id: tenantId, name: "Acme Technologies", status: "trial", subdomain: "acme" };
  const actor = async (first: string, permissions: string[]): Promise<Actor> => {
    const [e] = await withTenant(tenantId, (tx) => tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`);
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(permissions), grants: [{ permissions, scopes: [] }] };
  };

  await withTenant(tenantId, async (tx) => {
    await exits.ensureExitDefaults(tx, tenantId);
    await ensureLetterDefaults(tx, tenantId);
    await tx`update roles set permissions = (select array_agg(distinct p) from unnest(permissions || ${["exits.manage", "documents.manage"]}::text[]) p) where key = 'hr_admin'`;
    // engineers have a longer notice period
    await tx`update employees set notice_period_policy_id = (select id from notice_period_policies where days = 60 limit 1)
             where department_id = (select id from departments where name = 'Engineering')`;
  });

  const priya = await actor("Priya", ["employees.read", "employees.write", "exits.manage", "documents.manage", "approvals.override"]);

  // folders and documents
  await withTenant(tenantId, async (tx) => {
    const [sales] = await tx<{ id: string }[]>`select id from departments where name = 'Sales'`;
    const everyone = await docs.saveFolder(tx, priya, null, { name: "Company policies", access: { type: "org" } });
    const salesFolder = await docs.saveFolder(tx, priya, null, { name: "Sales playbook", access: { type: "departments", ids: [sales.id] } });
    await docs.saveFolder(tx, priya, null, { name: "Forms", access: { type: "org" } });
    const pdf = (title: string, paras: string[]) => renderLetterPdf({ title, company: "Acme Technologies", footer: title, html: `<h2>${title}</h2>` + paras.map((p) => `<p>${p}</p>`).join("") });
    await docs.uploadDocument(tx, priya, { folderId: everyone.id, title: "Leave and holiday policy", description: "How leave works at Acme: types, balances and approvals.", requiresAck: true, blockUntilAck: false,
      file: { name: "Leave and holiday policy.pdf", bytes: await pdf("Leave and holiday policy", ["Everyone gets casual, sick and earned leave each year.", "Apply in erp at least a week ahead for planned leave.", "Your manager approves leave; HR can help with anything unusual."]) } });
    await docs.uploadDocument(tx, priya, { folderId: everyone.id, title: "Code of conduct", description: null, requiresAck: false, blockUntilAck: false,
      file: { name: "Code of conduct.pdf", bytes: await pdf("Code of conduct", ["Treat colleagues and customers with respect.", "Raise concerns with your manager or HR, without fear of retaliation."]) } });
    await docs.uploadDocument(tx, priya, { folderId: salesFolder.id, title: "Customer data handling", description: "Read this before you use the CRM.", requiresAck: true, blockUntilAck: true,
      file: { name: "Customer data handling.pdf", bytes: await pdf("Customer data handling", ["Customer contact details stay inside the CRM.", "Never export lists to personal devices or email."]) } });
  });

  // Imran resigns (waiting for Sneha, then HR)
  const imran = await actor("Imran", []);
  await withTenant(tenantId, async (tx) => {
    const [reason] = await tx<{ id: string }[]>`select id from exit_reasons where name = 'Higher studies'`;
    await exits.resign(tx, imran, { reasonId: reason.id, comments: "I'm starting a master's programme in January." });
  });

  // Divya's resignation recorded by HR and serving notice
  await withTenant(tenantId, async (tx) => {
    const [divya] = await tx<{ id: string }[]>`select id from employees where first_name = 'Divya'`;
    const [reason] = await tx<{ id: string }[]>`select id from exit_reasons where name = 'Relocation'`;
    await exits.initiateExit(tx, priya, { employeeId: divya.id, kind: "resignation", reasonId: reason.id, resignationDate: addDaysISO(today, -9), lastWorkingDate: addDaysISO(today, 21), okToRehire: true, comments: "Moving to Kochi with family." });
  });

  // Nikhil left last month: relieved by the exits job, with a relieving letter on file
  await withTenant(tenantId, async (tx) => {
    const [ops] = await tx<{ id: string }[]>`select id from departments where name = 'Operations'`;
    const [title] = await tx<{ id: string }[]>`select id from designations where title = 'Operations Associate'`;
    const [mgr] = await tx<{ id: string }[]>`select id from employees where first_name = 'Priya'`;
    const n = await createEmployee(tx, tenantId, { firstName: "Nikhil", lastName: "Menon", workEmail: "nikhil@acme.test", joiningDate: addDaysISO(today, -700), departmentId: ops.id, designationId: title.id, managerId: mgr.id }, null);
    const [reason] = await tx<{ id: string }[]>`select id from exit_reasons where name = 'Better opportunity'`;
    const x = await exits.initiateExit(tx, priya, { employeeId: n.employeeId, kind: "resignation", reasonId: reason.id, resignationDate: addDaysISO(today, -75), lastWorkingDate: addDaysISO(today, -15), okToRehire: true });
    await tx`update tasks set status = 'done', completed_at = now() where process_id = (select process_id from exit_requests where id = ${x.id})`;
    const [tpl] = await tx<{ id: string }[]>`select id from letter_templates where kind = 'relieving' limit 1`;
    await generateLetter(tx, priya, tpl.id, n.employeeId, { notify: false });
    await exits.processDueExits(tx, today);
  });
}
