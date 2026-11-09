import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { withTenant } from "@/server/db";
import { currentSubdomain, resolveTenant } from "@/server/auth/session";
import { DevMailbox } from "./mailbox";

export const metadata: Metadata = { title: "Dev mailbox" };

/** Local development only: every email this tenant "sent" (nothing leaves the machine without RESEND_API_KEY). */
async function Inbox() {
  const sub = await currentSubdomain();   // request-time first, so the guard below is evaluated per request, not baked into the prerender
  if (process.env.NODE_ENV === "production" && process.env.ERP_DEMO !== "1") notFound();
  const tenant = await resolveTenant(sub);
  if (!tenant) return <p className="p-6">Open this on a workspace address, e.g. acme.localhost:3100/dev/mail</p>;
  const mails = await withTenant(tenant.id, (tx) => tx<{ id: string; kind: string; to_email: string; subject: string; html: string; status: string; provider: string | null; created_at: Date }[]>`
    select id, kind, to_email, subject, html, status, provider, created_at from outbound_emails order by created_at desc limit 50`);
  return <DevMailbox tenant={tenant.name} mails={mails.map((m) => ({ ...m, created_at: m.created_at.toISOString() }))} />;
}

export default function DevMailPage() {
  return <Suspense fallback={<p className="p-6">Loading…</p>}><Inbox /></Suspense>;
}
