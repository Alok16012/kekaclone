import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { withTenant } from "@/server/db";
import { currentSubdomain, resolveTenant } from "@/server/auth/session";
import { Badge } from "@/ui/badge";

export const metadata: Metadata = { title: "Dev SMS log" };

/** Local development only: every SMS this tenant "sent" (nothing leaves the machine without MSG91 keys). */
async function Log() {
  if (process.env.NODE_ENV === "production") notFound();
  const tenant = await resolveTenant(await currentSubdomain());
  if (!tenant) return <p className="p-6">Open this on a workspace address, e.g. acme.localhost:3100/dev/sms</p>;
  const rows = await withTenant(tenant.id, (tx) => tx<{ id: string; kind: string; to_phone: string; body: string; status: string; provider: string | null; created_at: Date }[]>`
    select id, kind, to_phone, body, status, provider, created_at from outbound_sms order by created_at desc limit 50`);
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="flex items-center gap-3 border-b border-border bg-surface px-5 py-3">
        <h1 className="text-md font-semibold">Dev SMS log · {tenant.name}</h1>
        <Badge tone="warning">Local only, nothing is really sent</Badge>
      </header>
      <ul className="divide-y divide-border bg-surface">
        {rows.length === 0 && <li className="p-5 text-base text-text-muted">No messages yet.</li>}
        {rows.map((m) => (
          <li key={m.id} className="px-5 py-3">
            <p className="text-base">{m.body}</p>
            <p className="text-sm text-text-muted">to {m.to_phone} · {m.kind} · {m.status}{m.provider ? ` via ${m.provider}` : ""} · {m.created_at.toLocaleTimeString("en-IN")}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function DevSmsPage() {
  return <Suspense fallback={<p className="p-6">Loading…</p>}><Log /></Suspense>;
}
