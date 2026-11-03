import "server-only";
import { AppError, type Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { todayIn } from "@/lib/dates";
import { notifyEmployee } from "@/server/modules/approvals/service";
import { saveFile } from "@/server/storage";
import { DEFAULT_LETTERS, LETTER_KINDS, letterDate, mergeTemplate, safeFileName, sanitizeHtml, unknownPlaceholders, type LetterKind } from "./rules";
import { renderLetterPdf } from "./pdf";
import { DOCS, canManageDocs } from "./service";

export async function ensureLetterDefaults(tx: Tx, tenantId: string) {
  for (const l of DEFAULT_LETTERS) {
    await tx`insert into letter_templates (tenant_id, name, kind, body_html) values (${tenantId}, ${l.name}, ${l.kind}, ${l.body}) on conflict (tenant_id, name) do nothing`;
  }
}

export type TemplateRow = { id: string; name: string; kind: LetterKind; body_html: string; updated_at: Date; issued: number };

export async function listTemplates(tx: Tx) {
  return tx<TemplateRow[]>`
    select t.id, t.name, t.kind, t.body_html, t.updated_at, (select count(*)::int from generated_letters g where g.template_id = t.id) as issued
    from letter_templates t where t.kind <> 'offer' order by t.name`;   // offer letters are managed in Hiring settings
}

export async function saveTemplate(tx: Tx, actor: Actor, id: string | null, input: { name: string; kind: string; body: string }) {
  if (!canManageDocs(actor)) throw new AppError("forbidden", "You don't have access to do this.");
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new AppError("invalid", "Give the template a name.", "name");
  if (!LETTER_KINDS.some((k) => k.value === input.kind)) throw new AppError("invalid", "Pick what kind of letter this is.", "kind");
  const body = sanitizeHtml(input.body);
  if (!body.replace(/<[^>]+>/g, "").trim()) throw new AppError("invalid", "The letter is empty.", "body");
  const unknown = unknownPlaceholders(body);
  if (unknown.length) throw new AppError("invalid", `Unknown placeholder${unknown.length > 1 ? "s" : ""}: ${unknown.map((u) => `{{${u}}}`).join(", ")}. Use the Insert field menu.`, "body");
  try {
    return await tx.savepoint(async (sp) => {
      if (id) {
        const [r] = await sp<{ id: string }[]>`update letter_templates set name = ${name}, kind = ${input.kind}, body_html = ${body} where id = ${id} returning id`;
        if (!r) throw new AppError("not_found", "Template not found.");
        return r;
      }
      const [r] = await sp<{ id: string }[]>`insert into letter_templates (tenant_id, name, kind, body_html) values (${actor.tenant.id}, ${name}, ${input.kind}, ${body}) returning id`;
      return r;
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new AppError("conflict", "A template with this name already exists.", "name");
    throw e;
  }
}

export async function deleteTemplate(tx: Tx, actor: Actor, id: string) {
  if (!canManageDocs(actor)) throw new AppError("forbidden", "You don't have access to do this.");
  const r = await tx`delete from letter_templates where id = ${id}`;   // issued letters keep their PDF (template_id set null)
  if (!r.count) throw new AppError("not_found", "Template not found.");
}

/** Placeholder values for a person, as printed in letters. */
export async function valuesFor(tx: Tx, employeeId: string) {
  const [e] = await tx<{ display_name: string; first_name: string; employee_number: string; work_email: string; designation: string | null; department: string | null; location: string | null; joining_date: string; manager: string | null; company: string; exit_date: string | null }[]>`
    select e.display_name, e.first_name, e.employee_number, e.work_email, d.title as designation, dp.name as department, l.name as location,
      e.joining_date::text, m.display_name as manager, (select name from tenants) as company, e.exit_date::text
    from employees e left join designations d on d.id = e.designation_id left join departments dp on dp.id = e.department_id
    left join locations l on l.id = e.location_id left join employees m on m.id = e.manager_id where e.id = ${employeeId}`;
  if (!e) throw new AppError("not_found", "Employee not found.");
  const [x] = await tx<{ resignation_date: string; last_working_date: string }[]>`
    select resignation_date::text, last_working_date::text from exit_requests where employee_id = ${employeeId} and status in ('in_progress','exited','under_review')
    order by created_at desc limit 1`;
  return {
    "employee.name": e.display_name, "employee.first_name": e.first_name, "employee.number": e.employee_number, "employee.email": e.work_email,
    "employee.designation": e.designation, "employee.department": e.department, "employee.location": e.location,
    "employee.joining_date": letterDate(e.joining_date), "employee.resignation_date": letterDate(x?.resignation_date),
    "employee.last_working_date": letterDate(x?.last_working_date ?? e.exit_date), "manager.name": e.manager, "company.name": e.company,
    today: letterDate(todayIn()),
  } as Record<string, string | null>;
}

async function guard(tx: Tx, actor: Actor, employeeId: string) {
  const [p] = await tx<Placement[]>`select department_id, location_id, legal_entity_id, business_unit_id from employees where id = ${employeeId}`;
  if (!p) throw new AppError("not_found", "Employee not found.");
  if (!canFor(actor, DOCS, p)) throw new AppError("forbidden", "You can't issue letters for this person.");
}

async function template(tx: Tx, id: string) {
  const [t] = await tx<{ id: string; name: string; kind: string; body_html: string }[]>`select id, name, kind, body_html from letter_templates where id = ${id} and kind <> 'offer'`;
  if (!t) throw new AppError("not_found", "Template not found.", "templateId");
  return t;
}

/** The merged letter as HTML, plus placeholders that have no value for this person. Nothing is saved. */
export async function previewLetter(tx: Tx, actor: Actor, templateId: string, employeeId: string) {
  await guard(tx, actor, employeeId);
  const t = await template(tx, templateId);
  const merged = mergeTemplate(sanitizeHtml(t.body_html), await valuesFor(tx, employeeId));
  return { name: t.name, html: merged.html, missing: merged.missing };
}

/** Render the letter to PDF, store it, and put it in the person's Documents tab. */
export async function generateLetter(tx: Tx, actor: Actor, templateId: string, employeeId: string, opts: { notify?: boolean } = {}) {
  await guard(tx, actor, employeeId);
  const t = await template(tx, templateId);
  const values = await valuesFor(tx, employeeId);
  const merged = mergeTemplate(sanitizeHtml(t.body_html), values);
  const today = todayIn();
  const pdf = await renderLetterPdf({ html: merged.html, title: `${t.name} · ${values["employee.name"]}`, company: values["company.name"] ?? actor.tenant.name, footer: `${t.name} for ${values["employee.name"]} · issued ${letterDate(today)}` });
  const fileName = safeFileName(`${t.name} - ${values["employee.name"]}.pdf`);
  const fileId = await saveFile(tx, { tenantId: actor.tenant.id, userId: actor.userId, name: fileName, mime: "application/pdf", bytes: pdf, ext: "pdf" });
  const [g] = await tx<{ id: string }[]>`
    insert into generated_letters (tenant_id, template_id, employee_id, data, file_id, status, published_at)
    values (${actor.tenant.id}, ${t.id}, ${employeeId}, ${tx.json({ values, missing: merged.missing } as never)}, ${fileId}, 'published', now()) returning id`;
  const [d] = await tx<{ id: string }[]>`
    insert into employee_documents (tenant_id, employee_id, category, doc_type, file_id, status, verified_by, verified_at)
    values (${actor.tenant.id}, ${employeeId}, 'letter', ${t.name}, ${fileId}, 'verified', ${actor.userId}, now()) returning id`;
  if (opts.notify !== false) await notifyEmployee(tx, actor.tenant.id, employeeId, "letter.issued", "A letter was added to your documents", t.name, `/people/${employeeId}`);
  await tx`insert into audit_logs (tenant_id, actor_user_id, entity_type, entity_id, action, diff)
           values (${actor.tenant.id}, ${actor.userId}, 'generated_letter', ${g.id}, 'letter.generate', ${tx.json({ template: t.name, employee_id: employeeId, missing: merged.missing })})`;
  return { letterId: g.id, documentId: d.id, fileId, missing: merged.missing, bytes: pdf.byteLength };
}
