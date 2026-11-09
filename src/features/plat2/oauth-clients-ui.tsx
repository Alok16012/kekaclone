"use client";
import * as React from "react";
import Link from "next/link";
import { Copy, Plus, ShieldCheck } from "lucide-react";
import { Button, IconButton } from "@/ui/button";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Checkbox } from "@/ui/choice";
import { Field, Input } from "@/ui/field";
import { Banner, EmptyState } from "@/ui/feedback";
import { ConfirmDialog, Modal } from "@/ui/overlay";
import { DataTable } from "@/ui/table";
import { toast } from "@/ui/toast";
import { API_SCOPES } from "@/server/modules/integrations/rules";
import type { OAuthClientRow } from "@/server/modules/integrations/oauth";
import { createOAuthClientAction, revokeOAuthClientAction } from "@/app/(app)/settings/api/oauth-actions";

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "—");

function Secret({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-sm text-text-muted">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-sm bg-surface px-2 py-1 font-mono text-sm">{value}</code>
        <IconButton label={`Copy ${label}`} onClick={() => navigator.clipboard?.writeText(value).then(() => toast.success("Copied"))}><Copy /></IconButton>
      </div>
    </div>
  );
}

/** OAuth2 client credentials: id + secret (shown once), scoped, revocable; tokens from /api/oauth/token. */
export function OAuthClientsCard({ clients, allowed, host }: { clients: OAuthClientRow[]; allowed: boolean; host: string }) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [scopes, setScopes] = React.useState<string[]>(["employees:read"]);
  const [created, setCreated] = React.useState<{ clientId: string; secret: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const reset = () => { setName(""); setScopes(["employees:read"]); setCreated(null); setError(null); };
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><ShieldCheck className="size-4 text-text-muted" aria-hidden />OAuth2 clients</span>}
        description={<>Client credentials for the same API: exchange the id and secret at <code className="font-mono text-sm">POST https://{host}/api/oauth/token</code> for a one-hour access token. Full details on the <Link href="/developers" className="text-accent-text hover:underline">developer page</Link>.</>}
        action={<Modal open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }} title="New OAuth2 client" size="md"
          trigger={<Button size="sm" disabled={!allowed}><Plus />New client</Button>}
          footer={created ? <Button onClick={() => { setOpen(false); reset(); }}>Done</Button> : <><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={pending} disabled={!name.trim() || !scopes.length} onClick={() => start(async () => {
            setError(null); const r = await createOAuthClientAction({ name, scopes }); if (r.ok) setCreated({ clientId: r.data!.clientId, secret: r.data!.secret }); else setError(r.error);
          })}>Create client</Button></>}>
          {created ? (
            <div className="flex flex-col gap-3 rounded-md border border-warning/40 bg-warning-soft p-3">
              <p className="text-sm font-medium text-warning-text">Copy the secret now: it won&apos;t be shown again.</p>
              <Secret label="Client id" value={created.clientId} />
              <Secret label="Client secret" value={created.secret} />
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {error && <Banner tone="danger">{error}</Banner>}
              <Field label="Name" help="Which system will use it, e.g. 'Zapier' or 'Attendance kiosk'."><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={80} /></Field>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium">Scopes the client may ask for</legend>
                {API_SCOPES.map((s) => <Checkbox key={s.key} label={<span><span className="font-mono text-sm">{s.key}</span> <span className="text-text-muted">— {s.label}</span></span>} checked={scopes.includes(s.key)} onCheckedChange={(c) => setScopes(c ? [...scopes, s.key] : scopes.filter((x) => x !== s.key))} />)}
              </fieldset>
            </div>
          )}
        </Modal>} />
      {!allowed && <CardBody><Banner tone="info">The public API is available on the Pro plan.</Banner></CardBody>}
      {clients.length === 0 ? <CardBody><EmptyState compact title="No OAuth2 clients" description="Create one for systems that prefer client credentials and short-lived tokens over long-lived keys." /></CardBody> : (
        <DataTable caption="OAuth2 clients" rows={clients} rowKey={(r) => r.id} columns={[
          { key: "name", header: "Name", cell: (r) => <span className="font-medium">{r.name}</span> },
          { key: "id", header: "Client id", cell: (r) => <code className="font-mono text-sm">{r.client_id}</code> },
          { key: "scopes", header: "Scopes", hideBelow: "md", cell: (r) => <span className="text-sm text-text-muted">{r.scopes.join(", ")}</span> },
          { key: "used", header: "Last token", hideBelow: "lg", cell: (r) => when(r.last_used_at) },
          { key: "status", header: "Status", cell: (r) => r.revoked_at ? <Badge tone="neutral">Revoked {when(r.revoked_at)}</Badge> : <Badge tone="success">Active</Badge> },
          { key: "actions", header: <span className="sr-only">Actions</span>, align: "right", cell: (r) => r.revoked_at ? null : (
            <ConfirmDialog trigger={<Button size="sm" variant="ghost">Revoke</Button>} title={`Revoke "${r.name}"?`} description="Tokens already issued stop working immediately." confirmLabel="Revoke"
              onConfirm={async () => { const x = await revokeOAuthClientAction(r.id); if (x.ok) toast.success("Client revoked"); else toast.error(x.error); }} />
          ) },
        ]} />
      )}
    </Card>
  );
}
