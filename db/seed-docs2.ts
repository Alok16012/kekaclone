/**
 * Demo data for the docs2 package (called from db/seed.ts): a passport with an expiry date on Rohan's profile,
 * Nikhil's relieving letter signed through erp Sign, a finished bulk batch of experience letters for Sales,
 * and Nikhil's exit survey answers. Divya (serving notice) has her survey waiting, sent when her exit started.
 */
import { withTenant } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { addDaysISO, todayIn } from "@/lib/dates";
import { renderLetterPdf } from "@/server/modules/documents/pdf";
import * as docs from "@/server/modules/documents/service";
import * as bulk from "@/server/modules/documents/bulk";
import * as esign from "@/server/modules/documents/esign";
import { submitExitSurvey } from "@/server/modules/exits/survey";
import { saveLoginBackground } from "@/server/modules/saas/branding";

export async function seedDocs2(tenantId: string) {
  const today = todayIn();
  const tenant = { id: tenantId, name: "Acme Technologies", status: "trial", subdomain: "acme", plan: "pro" as const };
  const actor = async (first: string, permissions: string[]): Promise<Actor> => {
    const [e] = await withTenant(tenantId, (tx) => tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`);
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(permissions), grants: [{ permissions, scopes: [] }] };
  };
  const priya = await actor("Priya", ["employees.read", "employees.write", "exits.manage", "documents.manage", "approvals.override"]);
  const rohan = await actor("Rohan", []);
  const asha = await actor("Asha", ["*"]);

  // Rohan uploads his passport (expires in 20 days → the daily job reminds him and HR); Priya verifies it
  await withTenant(tenantId, async (tx) => {
    const pdf = await renderLetterPdf({ title: "Passport", company: "Acme Technologies", footer: "Passport scan", html: "<p>Passport scan (demo)</p>" });
    const d = await docs.uploadPersonDocument(tx, rohan, rohan.employeeId, { category: "identity", docType: "Passport", number: "P1234567", expiryDate: addDaysISO(today, 20), file: { name: "passport.pdf", bytes: pdf } });
    await docs.reviewPersonDocument(tx, priya, d.id, { status: "verified", expiryDate: addDaysISO(today, 20) });
    const [arjun] = await tx<{ id: string }[]>`select id from employees where first_name = 'Arjun'`;
    const d2 = await docs.uploadPersonDocument(tx, priya, arjun.id, { category: "identity", docType: "Driving licence", expiryDate: addDaysISO(today, -5), file: { name: "licence.pdf", bytes: pdf } });
    await docs.reviewPersonDocument(tx, priya, d2.id, { status: "rejected", comment: "The scan is blurred. Please upload a clearer copy.", expiryDate: addDaysISO(today, -5) });
  });

  // Nikhil's relieving letter, signed by Priya through erp Sign (typed signature)
  await withTenant(tenantId, async (tx) => {
    const [nikhil] = await tx<{ id: string }[]>`select id from employees where first_name = 'Nikhil'`;
    const [letter] = await tx<{ id: string }[]>`select id from generated_letters where employee_id = ${nikhil.id} order by created_at limit 1`;
    if (!letter) return;
    await esign.requestSignatures(tx, priya, letter.id, [{ employeeId: priya.employeeId, title: "HR Manager" }], "Please sign Nikhil's relieving letter.");
    const [mail] = await tx<{ html: string }[]>`select html from outbound_emails where kind = 'esign.request' order by created_at desc limit 1`;
    const token = /\/sign\/([A-Za-z0-9_-]+)/.exec(mail.html)![1];
    await esign.requestSignCode(tx, tenant, token);
    const [codeMail] = await tx<{ subject: string }[]>`select subject from outbound_emails where kind = 'esign.code' order by created_at desc limit 1`;
    const code = /(\d{6})/.exec(codeMail.subject)![1];
    const r = await esign.sign(tx, tenant, token, { code, method: "typed", typedName: priya.name, ip: "127.0.0.1" });
    if (!r.ok) throw new Error(r.error);
  });

  // a bulk batch: experience letters for everyone in Sales (runs to completion right away)
  const batch = await withTenant(tenantId, async (tx) => {
    const [sales] = await tx<{ id: string }[]>`select id from departments where name = 'Sales'`;
    const [tpl] = await tx<{ id: string }[]>`select id from letter_templates where kind = 'experience' limit 1`;
    return bulk.createBatch(tx, priya, { templateId: tpl.id, filters: { departmentIds: [sales.id] } });
  });
  await bulk.runBatch(tenantId, batch.id);

  // Nikhil answered the exit survey before he left
  await withTenant(tenantId, async (tx) => {
    const [n] = await tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = 'Nikhil'`;
    const nikhil: Actor = { tenant, userId: n.user_id, employeeId: n.id, name: n.display_name, email: "", title: null, roles: [], permissions: new Set(), grants: [] };
    const qs = await tx<{ id: string; type: string; options: string[] }[]>`select id, type, options from exit_survey_questions where archived_at is null order by position`;
    const answers: Record<string, string | number | boolean> = {};
    for (const q of qs) answers[q.id] = q.type === "rating" ? 4 : q.type === "yes_no" ? true : q.type === "choice" ? q.options[0] : "A great team. A clearer growth path would have kept me longer.";
    await submitExitSurvey(tx, nikhil, answers).catch(() => {});
  });

  // a calm sign-in background (a tiny generated PNG) so the branding page has something to show
  await withTenant(tenantId, async (tx) => {
    await saveLoginBackground(tx, asha, { name: "login-background.png", mime: "image/png", bytes: tinyPng() });
  });
}

/** A 1×1 PNG with a soft blue pixel (valid file, 68 bytes). */
function tinyPng() {
  return new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkMLD4DwABbwE6W/7bFgAAAABJRU5ErkJggg==", "base64"));
}
