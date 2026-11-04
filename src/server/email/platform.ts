import "server-only";
import { sql } from "@/server/db";

/**
 * Emails that belong to no workspace yet (the sign-up verification code). Recorded in platform_emails and sent through
 * the same provider as tenant mail; without RESEND_API_KEY nothing leaves the machine and the apex /dev/mail shows it.
 */
const PROVIDER = process.env.RESEND_API_KEY ? "resend" : "dev";
const FROM = process.env.EMAIL_FROM ?? "erp <notify@erp.app>";

export async function sendPlatformEmail(m: { kind: string; to: string; subject: string; html: string; text: string }) {
  const [row] = await sql<{ id: string }[]>`insert into platform_emails (kind, to_email, subject, html, text_body) values (${m.kind}, ${m.to}, ${m.subject}, ${m.html}, ${m.text}) returning id`;
  if (PROVIDER === "dev") {
    await sql`update platform_emails set status = 'sent', provider = 'dev', sent_at = now(), attempts = 1 where id = ${row.id}`;
    if (process.env.NODE_ENV !== "production") console.log(`[mail] ${m.to} · ${m.subject}`);
    return;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json", "idempotency-key": row.id },
      body: JSON.stringify({ from: FROM, to: [m.to], subject: m.subject, html: m.html, text: m.text }),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
    await sql`update platform_emails set status = 'sent', provider = 'resend', provider_id = ${body.id ?? null}, sent_at = now(), attempts = 1 where id = ${row.id}`;
  } catch (e) {
    await sql`update platform_emails set status = 'failed', attempts = 1, error = ${String((e as Error).message).slice(0, 500)} where id = ${row.id}`;
    throw e;
  }
}

/** Development only: the latest platform emails for the apex mailbox. */
export async function recentPlatformEmails() {
  return sql<{ id: string; kind: string; to_email: string; subject: string; html: string; status: string; provider: string | null; created_at: Date }[]>`
    select id, kind, to_email, subject, html, status, provider, created_at from platform_emails order by created_at desc limit 50`;
}
