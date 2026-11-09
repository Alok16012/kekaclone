import "server-only";
import type { Tx } from "@/server/db";
import type { Actor } from "@/server/auth/session";
import { canFor, type Placement } from "@/server/auth/permissions";
import { todayIn, type ISODate } from "@/lib/dates";
import { appUrl, queueEmail } from "@/server/email";
import { simpleEmail } from "@/server/email/simple";
import { notifyEmployee } from "@/server/modules/approvals/service";
import { emitEvent } from "@/server/modules/automations/service";
import { DOCS, hrFor } from "./service";
import { bucket, dueReminder, reminderText, type ExpiryBucket, type ReminderKey } from "./expiry-rules";

/**
 * Expiring documents: uploaded documents (employee_documents.expiry_date) and identity records (passport, driving
 * licence … in employee_identities). The daily job sends a reminder 30 and 7 days before to the person and HR in
 * scope; HR also has a list of everything expiring or expired.
 */
type Row = { source: "document" | "identity"; id: string; employee_id: string; name: string; doc_type: string; expiry_date: string; sent: Partial<Record<ReminderKey, string>> };

const IDENTITY_LABEL: Record<string, string> = { pan: "PAN", aadhaar: "Aadhaar", passport: "Passport", voter_id: "Voter ID", driving_licence: "Driving licence", other: "Identity document" };

async function withExpiry(tx: Tx, upTo: ISODate): Promise<Row[]> {
  const docs = await tx<Row[]>`
    select 'document' as source, d.id, d.employee_id, e.display_name as name, d.doc_type, d.expiry_date::text, d.expiry_reminders as sent
    from employee_documents d join employees e on e.id = d.employee_id
    where d.expiry_date is not null and d.expiry_date <= ${upTo} and e.status <> 'relieved' and d.status <> 'rejected'`;
  const ids = await tx<Row[]>`
    select 'identity' as source, i.id, i.employee_id, e.display_name as name, i.kind as doc_type, i.expiry_date::text, i.expiry_reminders as sent
    from employee_identities i join employees e on e.id = i.employee_id
    where i.expiry_date is not null and i.expiry_date <= ${upTo} and e.status <> 'relieved'`;
  return [...docs, ...ids.map((r) => ({ ...r, doc_type: IDENTITY_LABEL[r.doc_type] ?? r.doc_type }))];
}

/** Daily job: send the 30-day / 7-day reminders that are due. Idempotent: each reminder is recorded on the row. */
export async function sendExpiryReminders(tx: Tx, tenant: { id: string; name: string; subdomain: string }, today: ISODate = todayIn()) {
  const rows = await withExpiry(tx, addDays(today, 30));
  let sent = 0;
  for (const r of rows) {
    const key = dueReminder(r.expiry_date, today, r.sent ?? {});
    if (!key) continue;
    const text = reminderText(r.doc_type, r.expiry_date, today);
    const link = `/people/${r.employee_id}?tab=documents`;
    await notifyEmployee(tx, tenant.id, r.employee_id, "document.expiry", "A document is about to expire", `${text}. Please upload the renewed one.`, link);
    const [p] = await tx<{ work_email: string }[]>`select work_email::text as work_email from employees where id = ${r.employee_id}`;
    if (p) {
      const mail = simpleEmail({ company: tenant.name, subject: `${text}`, heading: text, paragraphs: [`Hi ${r.name.split(" ")[0]},`, `Your ${r.doc_type} on file with ${tenant.name} expires on ${fmt(r.expiry_date)}. Please upload the renewed document so your records stay current.`], button: { label: "Open my documents", url: appUrl(tenant.subdomain, link) } });
      await queueEmail(tx, tenant.id, { kind: "document.expiry", to: p.work_email, ...mail });
    }
    for (const hr of await hrFor(tx, r.employee_id)) await notifyEmployee(tx, tenant.id, hr, "document.expiry", `${r.name}: ${text}`, "Check the expiring documents list.", "/org/documents/expiring");
    await emitEvent(tx, tenant.id, "document.expiring", { employeeId: r.employee_id, occurrence: `${r.source}:${r.id}:${key}`, link, facts: { "document.days_left": key }, vars: { "document.type": r.doc_type, "document.expiry_date": r.expiry_date } });   // Settings → Automations
    const patch = { [key]: new Date().toISOString() };
    if (r.source === "document") await tx`update employee_documents set expiry_reminders = expiry_reminders || ${tx.json(patch)} where id = ${r.id}`;
    else await tx`update employee_identities set expiry_reminders = expiry_reminders || ${tx.json(patch)} where id = ${r.id}`;
    sent++;
  }
  return { checked: rows.length, sent };
}

export type ExpiringRow = { source: "document" | "identity"; id: string; employee_id: string; name: string; department: string | null; doc_type: string; expiry_date: string; bucket: ExpiryBucket; reminded: string[] };

/** HR: documents expired or expiring within 90 days, for the people the actor manages documents for. */
export async function expiringDocuments(tx: Tx, actor: Actor, today: ISODate = todayIn()): Promise<ExpiringRow[]> {
  const rows = await withExpiry(tx, addDays(today, 90));
  if (!rows.length) return [];
  const people = await tx<(Placement & { id: string; department: string | null })[]>`
    select e.id, e.department_id, e.location_id, e.legal_entity_id, e.business_unit_id, dp.name as department from employees e left join departments dp on dp.id = e.department_id
    where e.id = any(${[...new Set(rows.map((r) => r.employee_id))]}::uuid[])`;
  const byId = new Map(people.map((p) => [p.id, p]));
  return rows
    .filter((r) => { const p = byId.get(r.employee_id); return p && (canFor(actor, DOCS, p) || canFor(actor, "employees.write", p)); })
    .map((r) => ({ source: r.source, id: r.id, employee_id: r.employee_id, name: r.name, department: byId.get(r.employee_id)?.department ?? null, doc_type: r.doc_type, expiry_date: r.expiry_date, bucket: bucket(r.expiry_date, today), reminded: Object.keys(r.sent ?? {}) }))
    .sort((a, b) => a.expiry_date.localeCompare(b.expiry_date) || a.name.localeCompare(b.name));
}

function addDays(d: ISODate, n: number) { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
const fmt = (d: ISODate) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
