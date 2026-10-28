import "server-only";
import { withTenant, type Tx } from "@/server/db";

export type Mail = { kind: string; to: string; subject: string; html: string; text: string };

/** Queue an email inside the caller's transaction, so it's only sent if the change it describes is committed. */
export async function queueEmail(tx: Tx, tenantId: string, m: Mail) {
  const [r] = await tx<{ id: string }[]>`
    insert into outbound_emails (tenant_id, kind, to_email, subject, html, text_body) values (${tenantId}, ${m.kind}, ${m.to}, ${m.subject}, ${m.html}, ${m.text}) returning id`;
  return r.id;
}

const PROVIDER = process.env.RESEND_API_KEY ? "resend" : "dev";
const FROM = process.env.EMAIL_FROM ?? "erp <notify@erp.app>";

/**
 * Send this tenant's queued emails. Called after a successful action (post-commit).
 * Without RESEND_API_KEY the email is only recorded (status sent, provider dev) and shows in /dev/mail.
 * (Moves to a background job with retries in M2.)
 */
export async function deliverQueued(tenantId: string) {
  await withTenant(tenantId, async (tx) => {
    const queued = await tx<{ id: string; to_email: string; subject: string; html: string; text_body: string }[]>`
      select id, to_email, subject, html, text_body from outbound_emails where status = 'queued' and attempts < 5 order by created_at limit 50 for update skip locked`;
    for (const m of queued) {
      if (PROVIDER === "dev") {
        await tx`update outbound_emails set status = 'sent', provider = 'dev', sent_at = now(), attempts = attempts + 1 where id = ${m.id}`;
        if (process.env.NODE_ENV !== "production") console.log(`[mail] ${m.to_email} · ${m.subject}`);
        continue;
      }
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json", "idempotency-key": m.id },
          body: JSON.stringify({ from: FROM, to: [m.to_email], subject: m.subject, html: m.html, text: m.text_body }),
        });
        const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
        if (!res.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
        await tx`update outbound_emails set status = 'sent', provider = 'resend', provider_id = ${body.id ?? null}, sent_at = now(), attempts = attempts + 1 where id = ${m.id}`;
      } catch (e) {
        await tx`update outbound_emails set attempts = attempts + 1, error = ${String((e as Error).message).slice(0, 500)},
                 status = case when attempts + 1 >= 5 then 'failed' else 'queued' end where id = ${m.id}`;
      }
    }
  });
}

export function appUrl(subdomain: string, path: string) {
  const root = process.env.ROOT_DOMAIN ?? "erp.app";
  const proto = root.startsWith("localhost") ? "http" : "https";
  return `${proto}://${subdomain}.${root}${path}`;
}
