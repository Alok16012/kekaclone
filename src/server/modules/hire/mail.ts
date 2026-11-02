import "server-only";
import type { Tx } from "@/server/db";
import { queueEmail } from "@/server/email";
import { DEFAULT_EMAIL_TEMPLATES, mergeText } from "./rules";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Candidate-facing email: plain text body turned into simple inline-styled HTML (links made clickable). */
export function candidateMail(company: string, subject: string, body: string) {
  const paras = body.trim().split(/\n{2,}/).map((p) => esc(p).replace(/\n/g, "<br>").replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#2f5bea">$1</a>'));
  const html = `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:Inter,Segoe UI,Roboto,Arial,sans-serif;color:#14171c">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e2e5ea;border-radius:12px">
<tr><td style="padding:24px 28px 4px;font-size:13px;color:#535c68">${esc(company)}</td></tr>
${paras.map((p) => `<tr><td style="padding:10px 28px 0;font-size:15px;line-height:22px">${p}</td></tr>`).join("")}
<tr><td style="padding:24px 28px 24px;font-size:12px;color:#535c68">Sent by ${esc(company)}'s hiring team.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, html, text: body.trim() };
}

export type MailValues = Record<string, string | null | undefined>;

/** A hiring email template with placeholders filled. */
export async function renderTemplate(tx: Tx, key: string, values: MailValues) {
  const [t] = await tx<{ subject: string; body_html: string }[]>`select subject, body_html from email_templates where module = 'hire' and key = ${key}`;
  const d = DEFAULT_EMAIL_TEMPLATES.find((x) => x.key === key);
  const subject = mergeText(t?.subject ?? d?.subject ?? "", values), body = mergeText(t?.body_html ?? d?.body ?? "", values);
  return { subject, body };
}

/**
 * Queues an email to the candidate and records it on the application's activity (so it shows in the Emails tab).
 * Inside the caller's transaction: nothing is sent if the change it describes rolls back.
 */
export async function emailCandidate(tx: Tx, a: { tenantId: string; company: string; to: string; applicationId: string | null; actorEmployeeId: string | null; subject: string; body: string; kind: string }) {
  const m = candidateMail(a.company, a.subject.slice(0, 200), a.body.slice(0, 8000));
  const id = await queueEmail(tx, a.tenantId, { kind: `hire.${a.kind}`, to: a.to, ...m });
  if (a.applicationId) {
    await tx`insert into application_events (tenant_id, application_id, kind, data, actor_employee_id)
             values (${a.tenantId}, ${a.applicationId}, 'email', ${tx.json({ subject: m.subject, body: m.text.slice(0, 4000), to: a.to, template: a.kind, email_id: id })}, ${a.actorEmployeeId})`;
  }
  return id;
}

export async function emailFromTemplate(tx: Tx, a: { tenantId: string; company: string; to: string; applicationId: string | null; actorEmployeeId: string | null; key: string; values: MailValues }) {
  const r = await renderTemplate(tx, a.key, a.values);
  return emailCandidate(tx, { ...a, subject: r.subject, body: r.body, kind: a.key });
}
