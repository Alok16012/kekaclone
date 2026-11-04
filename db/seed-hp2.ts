/**
 * Demo data for the hiring and helpdesk assistants (called from db/seed.ts, after seed-hire): searchable text for the
 * company policy documents, hiring privacy settings (24-month retention), keyword match scores for the Backend
 * Engineer candidates (the offline scorer, so the seed never calls an outside service), an offer letter waiting for
 * Kavya to sign in her joiner portal, and one data-removal request waiting for a hiring admin.
 */
import { withTenant } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { renderLetterPdf } from "@/server/modules/documents/pdf";
import { saveFile } from "@/server/storage";
import { setLlmForTesting } from "@/server/modules/assist/provider";
import * as ai from "@/server/modules/hire/assist";

const POLICIES: Record<string, string> = {
  "Leave and holiday policy": `Annual leave
Everyone gets 18 days of earned leave a year, added at 1.5 days each month. Up to 30 unused days carry over to the next year; anything above that lapses on 31 March.

Sick leave
You get 12 days of sick leave a year. For more than two days in a row, upload a doctor's note in the leave request.

Casual leave
Casual leave is 6 days a year, for short personal needs. It doesn't carry over.

Applying for leave
Apply in the app under Me, Leave, at least three working days before planned leave. Your manager approves it. Unplanned leave should be applied for on the day you return.

Holidays
The company follows the published holiday calendar for your location. You can also pick two optional holidays a year from the restricted holiday list.

Work from home
You can work from home up to two days a week with your manager's agreement. Raise a work-from-home request in the app so attendance is marked correctly.`,
  "Code of conduct": `Respect at work
Treat colleagues, candidates and customers with respect. Harassment and discrimination of any kind are not tolerated.

Reporting concerns
Report concerns to your manager, to HR, or anonymously through the helpdesk under the Ethics category. Nobody is penalised for raising a concern in good faith.

Gifts
You may accept gifts worth up to 2,000 rupees from business partners. Declare anything above that to HR within a week.

Laptops and equipment
Company laptops are for work. Lock your screen when you step away and report a lost or stolen device to IT the same day.`,
  "Customer data handling": `Access
Only open customer records you need for the task in hand. Access is logged.

Sharing
Never send customer data to personal email or messaging apps. Use the shared drive with a link that expires.

Incidents
If customer data is sent to the wrong person or a device with customer data is lost, tell the security team through the helpdesk within one hour.`,
};

export async function seedHp2(tenantId: string) {
  const tenant = { id: tenantId, name: "Acme Technologies", status: "trial", subdomain: "acme" };
  const actor = async (first: string, permissions: string[]): Promise<Actor> => {
    const [e] = await withTenant(tenantId, (tx) => tx<{ id: string; user_id: string; display_name: string }[]>`select id, user_id, display_name from employees where first_name = ${first}`);
    return { tenant, userId: e.user_id, employeeId: e.id, name: e.display_name, email: "", title: null, roles: [], permissions: new Set(permissions), grants: [{ permissions, scopes: [] }] };
  };
  const aditya = await actor("Aditya", ["hire.recruit"]);

  await withTenant(tenantId, async (tx) => {
    for (const [title, text] of Object.entries(POLICIES)) {
      await tx`update org_documents set text_content = ${text}, text_extracted_at = now() where title = ${title}`;
    }
    // the tools the backend team uses, so the match scores have something specific to compare
    await tx`update jobs set description_html = description_html || '<p>Tools we use<br>• Java and Spring<br>• PostgreSQL<br>• AWS, Docker and Kubernetes</p>'
             where title = 'Backend Engineer' and description_html not like '%Tools we use%'`;
    await tx`insert into hire_settings (tenant_id, ai_enabled, candidate_retention_months) values (${tenantId}, true, 24) on conflict (tenant_id) do nothing`;
    await tx`insert into helpdesk_settings (tenant_id) values (${tenantId}) on conflict (tenant_id) do nothing`;

    // an offer letter HR issued to Kavya (a pre-joiner), waiting for her signature in the joiner portal
    const [kavya] = await tx<{ id: string; display_name: string }[]>`select id, display_name from employees where first_name = 'Kavya'`;
    const [tpl] = await tx<{ id: string }[]>`select id from letter_templates where kind = 'offer' order by created_at limit 1`;
    const [has] = kavya && tpl ? await tx`select 1 from generated_letters where employee_id = ${kavya.id} and template_id = ${tpl.id}` : [true];
    if (kavya && tpl && !has) {
      const bytes = await renderLetterPdf({
        html: `<p>Dear ${kavya.display_name},</p><p>We're happy to offer you the role of Software Engineer at Acme Technologies, with an annual CTC of ₹14,00,000.</p><p>Please sign this letter in your joining portal to accept.</p>`,
        title: "Offer letter", company: "Acme Technologies", footer: "Offer letter",
      });
      const fileId = await saveFile(tx, { tenantId, userId: null, name: `Offer letter - ${kavya.display_name}.pdf`, mime: "application/pdf", bytes, ext: "pdf" });
      await tx`insert into generated_letters (tenant_id, template_id, employee_id, data, file_id, status, published_at)
               values (${tenantId}, ${tpl.id}, ${kavya.id}, ${tx.json({ seeded: true })}, ${fileId}, 'pending_signature', now())`;
    }

    // a candidate with an offer out asked for their data to be removed: waits for a hiring admin
    const [c] = await tx<{ id: string }[]>`
      select a.candidate_id as id from offers o join applications a on a.id = o.application_id where o.status = 'released' order by o.created_at limit 1`;
    if (c) await tx`insert into candidate_privacy_requests (tenant_id, candidate_id, source, status, reason) values (${tenantId}, ${c.id}, 'portal', 'pending', 'I have accepted another offer.') on conflict do nothing`;
  });

  // keyword scores for the Backend Engineer pipeline (offline scorer only)
  setLlmForTesting(null);
  try {
    const [job] = await withTenant(tenantId, (tx) => tx<{ id: string }[]>`select id from jobs where title = 'Backend Engineer'`);
    if (job) {
      const { contexts } = await withTenant(tenantId, (tx) => ai.staleScoreContexts(tx, aditya, job.id, 60));
      const results = await Promise.all(contexts.map(async (c) => ({ c, r: await ai.computeScore(c) })));
      await withTenant(tenantId, async (tx) => { for (const x of results) await ai.saveScore(tx, aditya, x.c, x.r); });
    }
  } finally { setLlmForTesting(undefined); }
}
