"use client";
import * as React from "react";
import { Copy, KeyRound, Plus, RefreshCw, Send, Trash2, Webhook } from "lucide-react";
import { Button, IconButton } from "@/ui/button";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Checkbox, Switch } from "@/ui/choice";
import { Field, Input } from "@/ui/field";
import { Banner, EmptyState } from "@/ui/feedback";
import { ConfirmDialog, Drawer, Modal } from "@/ui/overlay";
import { DataTable } from "@/ui/table";
import { toast } from "@/ui/toast";
import { API_SCOPES, WEBHOOK_EVENTS } from "@/server/modules/integrations/rules";
import type { ApiKeyRow, DeliveryRow, EndpointRow } from "@/server/modules/integrations/service";
import { OAuthClientsCard } from "@/features/plat2/oauth-clients-ui";
import type { OAuthClientRow } from "@/server/modules/integrations/oauth";
import { createApiKeyAction, createEndpointAction, deleteEndpointAction, listDeliveriesAction, retryDeliveryAction, revokeApiKeyAction, sendTestEventAction, setEndpointActiveAction } from "@/app/(app)/settings/api/actions";

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "—");

function Secret({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning-soft p-3">
      <p className="text-sm font-medium text-warning-text">{label} Copy it now: it won&apos;t be shown again.</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-sm bg-surface px-2 py-1 font-mono text-sm">{value}</code>
        <IconButton label="Copy" onClick={() => navigator.clipboard?.writeText(value).then(() => toast.success("Copied"))}><Copy /></IconButton>
      </div>
    </div>
  );
}

/** Settings → API & webhooks: keys (shown once), scoped and revocable; endpoints with secrets, test events and a delivery log. */
export function ApiSettingsPage({ keys, clients = [], endpoints, apiAllowed, webhooksAllowed, host }: { keys: ApiKeyRow[]; clients?: OAuthClientRow[]; endpoints: EndpointRow[]; apiAllowed: boolean; webhooksAllowed: boolean; host: string }) {
  return (
    <div className="flex flex-col gap-4">
      <KeysCard keys={keys} allowed={apiAllowed} host={host} />
      <OAuthClientsCard clients={clients} allowed={apiAllowed} host={host} />
      <EndpointsCard endpoints={endpoints} allowed={webhooksAllowed} />
    </div>
  );
}

function KeysCard({ keys, allowed, host }: { keys: ApiKeyRow[]; allowed: boolean; host: string }) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [scopes, setScopes] = React.useState<string[]>(["employees:read"]);
  const [created, setCreated] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const reset = () => { setName(""); setScopes(["employees:read"]); setCreated(null); setError(null); };
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><KeyRound className="size-4 text-text-muted" aria-hidden />API keys</span>}
        description={<>Read-only REST API v1 at <code className="font-mono text-sm">https://{host}/api/v1/…</code> with <code className="font-mono text-sm">Authorization: Bearer &lt;key&gt;</code>. 120 requests per minute per key.</>}
        action={<Modal open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }} title="New API key" size="md"
          trigger={<Button size="sm" disabled={!allowed}><Plus />New key</Button>}
          footer={created ? <Button onClick={() => { setOpen(false); reset(); }}>Done</Button> : <><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={pending} disabled={!name.trim() || !scopes.length} onClick={() => start(async () => {
            setError(null); const r = await createApiKeyAction({ name, scopes }); if (r.ok) setCreated(r.data!.token); else setError(r.error);
          })}>Create key</Button></>}>
          {created ? <Secret value={created} label="Your new API key." /> : (
            <div className="flex flex-col gap-4">
              {error && <Banner tone="danger">{error}</Banner>}
              <Field label="Name" help="Which system will use it, e.g. 'Payroll sync' or 'BI dashboard'."><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={80} /></Field>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium">Scopes</legend>
                {API_SCOPES.map((s) => <Checkbox key={s.key} label={<span><span className="font-mono text-sm">{s.key}</span> <span className="text-text-muted">— {s.label}</span></span>} checked={scopes.includes(s.key)} onCheckedChange={(c) => setScopes(c ? [...scopes, s.key] : scopes.filter((x) => x !== s.key))} />)}
              </fieldset>
            </div>
          )}
        </Modal>} />
      {!allowed && <CardBody><Banner tone="info">The public API is available on the Pro plan. Existing keys stop working until the plan includes it.</Banner></CardBody>}
      {keys.length === 0 ? <CardBody><EmptyState compact title="No API keys" description="Create a key to let another system read your directory, leave and attendance." /></CardBody> : (
        <DataTable caption="API keys" rows={keys} rowKey={(r) => r.id} columns={[
          { key: "name", header: "Name", cell: (r) => <span className="font-medium">{r.name}</span> },
          { key: "prefix", header: "Key", cell: (r) => <code className="font-mono text-sm">erp_live_{r.key_prefix}_…</code> },
          { key: "scopes", header: "Scopes", hideBelow: "md", cell: (r) => <span className="text-sm text-text-muted">{r.scopes.join(", ")}</span> },
          { key: "used", header: "Last used", hideBelow: "lg", cell: (r) => when(r.last_used_at) },
          { key: "status", header: "Status", cell: (r) => r.revoked_at ? <Badge tone="neutral">Revoked {when(r.revoked_at)}</Badge> : <Badge tone="success">Active</Badge> },
          { key: "actions", header: <span className="sr-only">Actions</span>, align: "right", cell: (r) => r.revoked_at ? null : (
            <ConfirmDialog trigger={<Button size="sm" variant="ghost">Revoke</Button>} title={`Revoke "${r.name}"?`} description="Requests with this key stop working immediately." confirmLabel="Revoke"
              onConfirm={async () => { const x = await revokeApiKeyAction(r.id); if (x.ok) toast.success("Key revoked"); else toast.error(x.error); }} />
          ) },
        ]} />
      )}
    </Card>
  );
}

function EndpointsCard({ endpoints, allowed }: { endpoints: EndpointRow[]; allowed: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [url, setUrl] = React.useState("");
  const [events, setEvents] = React.useState<string[]>(["approval.decided"]);
  const [created, setCreated] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const [log, setLog] = React.useState<{ endpoint: EndpointRow; rows: DeliveryRow[] } | null>(null);
  const reset = () => { setUrl(""); setEvents(["approval.decided"]); setCreated(null); setError(null); };
  const openLog = (e: EndpointRow) => start(async () => { const r = await listDeliveriesAction(e.id); if (r.ok) setLog({ endpoint: e, rows: r.data ?? [] }); else toast.error(r.error); });
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><Webhook className="size-4 text-text-muted" aria-hidden />Webhooks</span>}
        description={<>erp POSTs JSON to your https endpoint, signed with <code className="font-mono text-sm">X-Erp-Signature: t=…,v1=hmac-sha256(secret, &quot;t.body&quot;)</code>. Failed deliveries retry after 1 min, 5 min, 30 min, 2 h and 12 h.</>}
        action={<Modal open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }} title="New webhook endpoint" size="md"
          trigger={<Button size="sm" disabled={!allowed}><Plus />Add endpoint</Button>}
          footer={created ? <Button onClick={() => { setOpen(false); reset(); }}>Done</Button> : <><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={pending} disabled={!url.trim() || !events.length} onClick={() => start(async () => {
            setError(null); const r = await createEndpointAction({ url, events }); if (r.ok) setCreated(r.data!.secret); else setError(r.error);
          })}>Add endpoint</Button></>}>
          {created ? <Secret value={created} label="Signing secret for this endpoint." /> : (
            <div className="flex flex-col gap-4">
              {error && <Banner tone="danger">{error}</Banner>}
              <Field label="Endpoint URL" help="https only, on a public host."><Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/erp-webhook" autoFocus spellCheck={false} /></Field>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium">Events</legend>
                {WEBHOOK_EVENTS.filter((e) => e.key !== "test.ping").map((e) => <Checkbox key={e.key} label={<span><span className="font-mono text-sm">{e.key}</span> <span className="text-text-muted">— {e.label}</span></span>} checked={events.includes(e.key)} onCheckedChange={(c) => setEvents(c ? [...events, e.key] : events.filter((x) => x !== e.key))} />)}
              </fieldset>
            </div>
          )}
        </Modal>} />
      {!allowed && <CardBody><Banner tone="info">Webhooks are available on the Pro plan.</Banner></CardBody>}
      {endpoints.length === 0 ? <CardBody><EmptyState compact title="No endpoints" description="Add an endpoint to get notified when requests are decided." /></CardBody> : (
        <ul className="divide-y divide-border border-t border-border">
          {endpoints.map((e) => (
            <li key={e.id} className="flex flex-col gap-2 px-5 py-3 md:flex-row md:items-center md:gap-4">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-sm">{e.url}</p>
                <p className="text-sm text-text-muted">{e.events.join(", ")} · {e.pending ? `${e.pending} pending` : "nothing pending"}{e.failed ? ` · ${e.failed} gave up` : ""}{e.last_status ? ` · last HTTP ${e.last_status} ${when(e.last_at)}` : ""}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Switch label={e.is_active ? "On" : "Off"} checked={e.is_active} disabled={pending} onCheckedChange={(c) => start(async () => { const r = await setEndpointActiveAction(e.id, c); if (!r.ok) toast.error(r.error); })} />
                <Button size="sm" variant="secondary" loading={pending} onClick={() => start(async () => { const r = await sendTestEventAction(e.id); if (r.ok) toast.success("Test event queued"); else toast.error(r.error); })}><Send />Test</Button>
                <Button size="sm" variant="ghost" onClick={() => openLog(e)}>Deliveries</Button>
                <ConfirmDialog trigger={<IconButton label="Delete endpoint"><Trash2 /></IconButton>} title="Delete this endpoint?" description="Its delivery history goes with it." confirmLabel="Delete"
                  onConfirm={async () => { const r = await deleteEndpointAction(e.id); if (r.ok) toast.success("Endpoint deleted"); else toast.error(r.error); }} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <Drawer open={!!log} onOpenChange={(o) => { if (!o) setLog(null); }} title="Deliveries" description={log?.endpoint.url}>
        {log && (log.rows.length === 0 ? <EmptyState compact title="Nothing sent yet" description="Send a test event to see a delivery here." /> : (
          <ul className="divide-y divide-border">
            {log.rows.map((d) => (
              <li key={d.id} className="flex items-start gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-base"><span className="font-mono text-sm">{d.event}</span> · {when(d.created_at)}</p>
                  <p className="text-sm text-text-muted">{d.delivered_at ? `Delivered ${when(d.delivered_at)} (HTTP ${d.last_status})` : d.attempts === 0 ? "Waiting to send" : `${d.attempts} ${d.attempts === 1 ? "attempt" : "attempts"} · ${d.last_error ?? `HTTP ${d.last_status}`} · ${d.next_attempt_at ? `next try ${when(d.next_attempt_at)}` : "gave up"}`}</p>
                </div>
                {d.delivered_at ? <Badge tone="success">Delivered</Badge> : d.next_attempt_at ? <Badge tone="warning">Retrying</Badge> : <Badge tone="danger">Failed</Badge>}
                {!d.delivered_at && !d.next_attempt_at && <IconButton label="Retry" onClick={() => start(async () => { const r = await retryDeliveryAction(d.id); if (r.ok) { toast.success("Queued for retry"); openLog(log.endpoint); } else toast.error(r.error); })}><RefreshCw /></IconButton>}
              </li>
            ))}
          </ul>
        ))}
      </Drawer>
    </Card>
  );
}
