import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { withTenant } from "@/server/db";
import { currentSubdomain, resolveTenant } from "@/server/auth/session";
import { recentPlatformEmails } from "@/server/email/platform";
import { DevMailbox } from "./mailbox";

export const metadata: Metadata = { title: "Dev mailbox" };

/** Local development only: every email this tenant "sent" (nothing leaves the machine without RESEND_API_KEY). */
async function Inbox() {
  const sub = await currentSubdomain();   // request-time first, so the guard below is evaluated per request, not baked into the prerender
  if (process.env.NODE_ENV === "production" && process.env.ERP_DEMO !== "1") notFound();
  const tenant = await resolveTenant(sub);
  if (!tenant) {
    // the apex has no workspace: show platform mail (sign-up verification codes)
    const mails = await recentPlatformEmails();
    return <DevMailbox tenant="erp (sign-up)" mails={mails.map((m) => ({ ...m, created_at: m.created_at.toISOString() }))} />;
  }
  const mails = await withTenant(tenant.id, (tx) => tx<{ id: string; kind: string; to_email: string; subject: string; html: string; status: string; provider: string | null; created_at: Date }[]>`
    select id, kind, to_email, subject, html, status, provider, created_at from outbound_emails order by created_at desc limit 50`);
  return <DevMailbox tenant={tenant.name} mails={mails.map((m) => ({ ...m, created_at: m.created_at.toISOString() }))} />;
}

export default function DevMailPage() {
  return <Suspense fallback={<p className="p-6">Loading…</p>}><Inbox /></Suspense>;
}
