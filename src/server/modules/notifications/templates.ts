/**
 * Per-event email templates (Settings → Notifications → Email templates). Pure: default subject/body per event,
 * placeholder catalogue, rendering and validation. The server merges a tenant's saved template over the default.
 */
import { NOTIFICATION_EVENTS } from "./events";

export const TEMPLATE_PLACEHOLDERS = [
  { key: "first_name", label: "Recipient's first name" },
  { key: "name", label: "Recipient's full name" },
  { key: "company", label: "Company name" },
  { key: "title", label: "What happened (the notification title)" },
  { key: "body", label: "The details (the notification text)" },
  { key: "link", label: "Link to the page in erp" },
  { key: "event", label: "Event name" },
] as const;
export type TemplateVars = Record<(typeof TEMPLATE_PLACEHOLDERS)[number]["key"], string>;

export type Template = { subject: string; body: string };

/** Every event starts with the same shape; a tenant edits the ones that matter to them. */
export const DEFAULT_TEMPLATE: Template = { subject: "{{title}} · {{company}}", body: "Hi {{first_name}},\n\n{{body}}" };

const SPECIAL: Record<string, Template> = {
  "approval.pending": { subject: "Waiting for you: {{body}}", body: "Hi {{first_name}},\n\nA request needs your decision:\n\n{{body}}\n\nOpen your Inbox to approve or decline it." },
  "request.approved": { subject: "Approved: {{body}}", body: "Hi {{first_name}},\n\nGood news — your request was approved.\n\n{{body}}" },
  "request.rejected": { subject: "Declined: {{body}}", body: "Hi {{first_name}},\n\nYour request was declined.\n\n{{body}}\n\nTalk to your approver if you'd like to know more." },
  "engage.announcement": { subject: "{{title}}", body: "Hi {{first_name}},\n\n{{body}}" },
  "payroll.payslip": { subject: "Your payslip is ready · {{company}}", body: "Hi {{first_name}},\n\n{{body}}\n\nYou can download it from My finances." },
  "document.ack": { subject: "Please acknowledge: {{body}}", body: "Hi {{first_name}},\n\n{{body}}\n\nPlease read and acknowledge it in erp." },
};

export const TEMPLATE_EVENTS = NOTIFICATION_EVENTS.map((g) => ({ group: g.group, events: g.events.filter((e) => !e.emailOnly || e.key !== "approvals.digest").map((e) => ({ key: e.key, label: e.label })) }));
const ALL_TEMPLATE_KEYS = new Set(TEMPLATE_EVENTS.flatMap((g) => g.events.map((e) => e.key)));
export const isTemplateEvent = (v: unknown): v is string => typeof v === "string" && ALL_TEMPLATE_KEYS.has(v);

export const defaultTemplate = (event: string): Template => SPECIAL[event] ?? DEFAULT_TEMPLATE;

/** {{placeholder}} → value. Unknown placeholders are left empty. */
export function renderTemplate(t: Template, vars: TemplateVars): { subject: string; paragraphs: string[] } {
  const fill = (s: string) => s.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, k: string) => (vars as Record<string, string>)[k] ?? "");
  const subject = fill(t.subject).replace(/\s+/g, " ").trim().slice(0, 200) || fill(DEFAULT_TEMPLATE.subject);
  const paragraphs = fill(t.body).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return { subject, paragraphs: paragraphs.length ? paragraphs : [vars.body] };
}

export const TEMPLATE_LIMITS = { subject: 200, body: 4000 };

export function validateTemplate(raw: unknown): { ok: true; value: Template } | { ok: false; message: string; field?: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const subject = typeof r.subject === "string" ? r.subject.trim() : "";
  const body = typeof r.body === "string" ? r.body.replace(/\r\n/g, "\n").trim() : "";
  if (!subject) return { ok: false, message: "Add a subject line.", field: "subject" };
  if (subject.length > TEMPLATE_LIMITS.subject) return { ok: false, message: `Keep the subject under ${TEMPLATE_LIMITS.subject} characters.`, field: "subject" };
  if (!body) return { ok: false, message: "Add the email text.", field: "body" };
  if (body.length > TEMPLATE_LIMITS.body) return { ok: false, message: `Keep the text under ${TEMPLATE_LIMITS.body} characters.`, field: "body" };
  const unknown = [...body.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi), ...subject.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/gi)].map((m) => m[1]).filter((k) => !TEMPLATE_PLACEHOLDERS.some((p) => p.key === k));
  if (unknown.length) return { ok: false, message: `Unknown placeholder: {{${unknown[0]}}}. Use one from the list.`, field: "body" };
  return { ok: true, value: { subject, body } };
}

/** Sample values for the preview. */
export const SAMPLE_VARS: TemplateVars = { first_name: "Asha", name: "Asha Verma", company: "Acme Technologies", title: "Your request was approved", body: "Casual leave · 12 Nov – 13 Nov (2 days)", link: "https://acme.erp.app/me/leave", event: "Your request was approved" };
