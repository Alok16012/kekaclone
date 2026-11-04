import type { Metadata } from "next";
import { Suspense } from "react";
import { headers } from "next/headers";
import { API_SCOPES, WEBHOOK_EVENTS } from "@/server/modules/integrations/rules";
import { openapiDocument } from "@/server/modules/integrations/openapi";

export const metadata: Metadata = { title: "Developers" };

/**
 * Public developer page for the workspace: how to authenticate (API keys or OAuth2 client credentials), every
 * endpoint from the OpenAPI document, webhooks and the Zapier-style REST hooks. No tenant data is shown.
 */
async function Docs() {
  const host = (await headers()).get("host") ?? "acme.erp.app";
  const doc = openapiDocument(host);
  const base = doc.servers[0].url;
  const ops = Object.entries(doc.paths).flatMap(([path, methods]) => Object.entries(methods as Record<string, { summary: string; tags?: string[]; description?: string; security?: { bearer: string[] }[] }>).map(([method, op]) => ({ path, method: method.toUpperCase(), ...op })));
  const code = "rounded-md border border-border bg-surface-sunken p-3 font-mono text-sm overflow-x-auto";
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
      <p className="text-sm text-text-muted">erp · {host}</p>
      <h1 className="text-3xl font-semibold tracking-tight">Developer guide</h1>
      <p className="mt-2 text-base text-text-muted">Everything below runs against this workspace&apos;s own address. The machine-readable description is at <a className="text-accent-text hover:underline" href="/api/v1/openapi.json">/api/v1/openapi.json</a>.</p>

      <h2 className="mt-10 text-xl font-semibold">1. Authenticate</h2>
      <p className="mt-2 text-base">Two options, both created by a workspace admin under Settings → API &amp; webhooks, both scoped and revocable:</p>
      <h3 className="mt-4 text-base font-semibold">API key</h3>
      <pre className={code}>{`curl ${base}/employees \\\n  -H "Authorization: Bearer erp_live_xxxxxxxx_…"`}</pre>
      <h3 className="mt-4 text-base font-semibold">OAuth2 client credentials</h3>
      <pre className={code}>{`curl -X POST ${base.replace(/\/v1$/, "")}/oauth/token \\\n  -u "erp_ci_…:erp_cs_…" \\\n  -d grant_type=client_credentials -d "scope=employees:read leave:write"\n\n{ "access_token": "eyJ…", "token_type": "Bearer", "expires_in": 3600, "scope": "employees:read leave:write" }`}</pre>
      <p className="mt-2 text-sm text-text-muted">Tokens last an hour and carry the scopes you asked for (a subset of the client&apos;s). Send them as <code className="font-mono">Authorization: Bearer</code>. Revoking the client invalidates its tokens at once. 120 requests per minute per key or client.</p>
      <h3 className="mt-4 text-base font-semibold">Scopes</h3>
      <ul className="mt-2 flex flex-col gap-1 text-sm">{API_SCOPES.map((s) => <li key={s.key}><code className="font-mono">{s.key}</code> <span className="text-text-muted">— {s.label}</span></li>)}</ul>

      <h2 className="mt-10 text-xl font-semibold">2. Endpoints</h2>
      <table className="mt-3 w-full text-sm">
        <thead><tr className="text-left text-text-muted"><th className="py-1 pr-3 font-medium">Method</th><th className="py-1 pr-3 font-medium">Path</th><th className="py-1 font-medium">What it does</th></tr></thead>
        <tbody>
          {ops.map((o) => (
            <tr key={o.method + o.path} className="border-t border-border align-top">
              <td className="py-1.5 pr-3 font-mono">{o.method}</td>
              <td className="py-1.5 pr-3 font-mono">{o.path.startsWith("/..") ? o.path.replace("/..", "/api") : `/api/v1${o.path}`}</td>
              <td className="py-1.5">{o.summary}{o.security?.[0]?.bearer?.length ? <span className="text-text-muted"> · {o.security[0].bearer.join(", ")}</span> : null}{o.description ? <p className="mt-0.5 text-text-muted">{o.description}</p> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-sm text-text-muted">Lists are paged with <code className="font-mono">limit</code> and <code className="font-mono">cursor</code> (from <code className="font-mono">next_cursor</code>). Errors look like <code className="font-mono">{`{ "error": { "code", "message" } }`}</code>.</p>
      <h3 className="mt-4 text-base font-semibold">Writes</h3>
      <pre className={code}>{`curl -X POST ${base}/leave-requests -H "Authorization: Bearer …" -H "Content-Type: application/json" \\\n  -d '{ "employee_number": "EMP0042", "leave_type_code": "CL", "from": "2026-11-12", "to": "2026-11-13", "note": "Family function" }'\n\ncurl -X POST ${base}/attendance/punches -H "Authorization: Bearer …" -H "Content-Type: application/json" \\\n  -d '{ "employee_number": "EMP0042", "at": "2026-11-03T09:31:00+05:30", "direction": "in", "external_id": "kiosk-1-000123" }'`}</pre>
      <p className="mt-2 text-sm text-text-muted">A leave request raised through the API is a normal request: the person&apos;s balances, notice rules and approval chain apply. Punches are idempotent per person by <code className="font-mono">external_id</code>.</p>

      <h2 className="mt-10 text-xl font-semibold">3. Webhooks and Zapier</h2>
      <p className="mt-2 text-base">Admins add webhook endpoints under Settings → API &amp; webhooks. Integrations such as Zapier can subscribe themselves with REST hooks:</p>
      <pre className={code}>{`# subscribe (returns the hook id and a signing secret once)\ncurl -X POST ${base}/hooks -H "Authorization: Bearer …" -H "Content-Type: application/json" \\\n  -d '{ "event": "employee.created", "target_url": "https://hooks.zapier.com/hooks/catch/…" }'\n\n# unsubscribe\ncurl -X DELETE ${base}/hooks/<id> -H "Authorization: Bearer …"\n\n# sample payload for building a Zap, and polling triggers (newest first, stable ids)\ncurl ${base}/hooks/sample/employee.created -H "Authorization: Bearer …"\ncurl ${base}/triggers/leave.approved?limit=25 -H "Authorization: Bearer …"`}</pre>
      <p className="mt-2 text-sm text-text-muted">Events: {WEBHOOK_EVENTS.filter((e) => e.key !== "test.ping").map((e) => <code key={e.key} className="mr-1 font-mono">{e.key}</code>)}. Each delivery is a JSON POST <code className="font-mono">{`{ id, type, created_at, data }`}</code> with <code className="font-mono">X-Erp-Signature: t=&lt;unix&gt;,v1=&lt;hmac-sha256(secret, t + &quot;.&quot; + body)&gt;</code>, retried with backoff (1 m, 5 m, 30 m, 2 h, 12 h). Answer 2xx to acknowledge.</p>

      <h2 className="mt-10 text-xl font-semibold">4. Slack and Teams</h2>
      <p className="mt-2 text-base text-text-muted">Connected under Settings → Integrations. Approval requests reach the channel with Approve / Decline. Slack buttons post to <code className="font-mono">/api/chat/slack</code> (signed with your app&apos;s signing secret); Teams buttons open a signed confirm page in erp.</p>
    </main>
  );
}

export default function DevelopersPage() {
  return <Suspense fallback={null}><Docs /></Suspense>;
}
