"use client";
import * as React from "react";
import { CalendarDays, Download, MessageSquare, Plug, Send, Unplug } from "lucide-react";
import { Button } from "@/ui/button";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Field, Input } from "@/ui/field";
import { Banner, EmptyState } from "@/ui/feedback";
import { Switch } from "@/ui/choice";
import { Select } from "@/ui/select";
import { ConfirmDialog } from "@/ui/overlay";
import { toast } from "@/ui/toast";
import type { integrationsOverview } from "@/server/modules/integrations/service";
import type { exportableRuns } from "@/server/modules/integrations/accounting";
import { ACCOUNTING_FORMATS } from "@/server/modules/integrations/rules";
import { removeIntegrationAction, saveChatIntegrationAction, sendChatTestAction, setCalendarPlaceholderAction } from "@/app/(app)/settings/integrations/actions";

type Overview = Awaited<ReturnType<typeof integrationsOverview>>;
type Runs = Awaited<ReturnType<typeof exportableRuns>>;

/** Settings → Integrations: Slack / Teams channel notifications, calendar placeholders, accounting export. */
export function IntegrationsPage({ overview, runs }: { overview: Overview; runs: Runs }) {
  return (
    <div className="flex flex-col gap-4">
      {!overview.allowed && <Banner tone="info">Integrations are available on the Plus plan. Upgrade in Settings → Billing to connect Slack, Teams and calendars.</Banner>}
      <ChatCard provider="slack" title="Slack" help="Create an Incoming Webhook in Slack (Apps → Incoming WebHooks), pick the channel, and paste the URL here." state={overview.slack} allowed={overview.allowed}
        extra={overview.chatApprovals.slackInteractive ? <Badge tone="success">Approve / decline buttons on</Badge> : <Badge tone="warning">Buttons off — add {overview.chatApprovals.slackHint}</Badge>} />
      <ChatCard provider="teams" title="Microsoft Teams" help="In the Teams channel, add the Incoming Webhook connector and paste its URL here." state={overview.teams} allowed={overview.allowed}
        extra={<Badge tone="success">Approve / decline links on</Badge>} />
      <CalendarCard calendars={overview.calendars} allowed={overview.allowed} />
      <AccountingCard runs={runs} allowed={overview.accountingAllowed} />
    </div>
  );
}

function ChatCard({ provider, title, help, state, allowed, extra }: { provider: "slack" | "teams"; title: string; help: string; state: Overview["slack"]; allowed: boolean; extra?: React.ReactNode }) {
  const [url, setUrl] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><MessageSquare className="size-4 text-text-muted" aria-hidden />{title}</span>}
        description="Posts to a channel when a request needs approval (with Approve / Decline) and when it's decided."
        action={state.connected ? <Badge tone={state.status === "error" ? "danger" : "success"}>{state.status === "error" ? "Last message failed" : "Connected"}</Badge> : <Badge tone="neutral">Not connected</Badge>} />
      <CardBody className="flex flex-col gap-3">
        {extra && <div>{extra}</div>}
        {state.connected ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-text-muted">Channel webhook: <span className="font-mono">{state.hint}</span></span>
            <Button size="sm" variant="secondary" loading={pending} onClick={() => start(async () => { const r = await sendChatTestAction(provider); if (r.ok) toast.success(`Test message sent to ${title}`); else toast.error(r.error); })}><Send />Send test</Button>
            <ConfirmDialog trigger={<Button size="sm" variant="ghost"><Unplug />Disconnect</Button>} title={`Disconnect ${title}?`} description="erp will stop posting to the channel." confirmLabel="Disconnect"
              onConfirm={async () => { const r = await removeIntegrationAction(provider); if (r.ok) toast.success(`${title} disconnected`); else toast.error(r.error); }} />
          </div>
        ) : (
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); start(async () => { setError(null); const r = await saveChatIntegrationAction(provider, url); if (r.ok) { toast.success(`${title} connected`); setUrl(""); } else setError(r.error); }); }}>
            <Field label="Incoming webhook URL" help={help} error={error ?? undefined} className="max-w-xl">
              <Input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" disabled={!allowed || pending} spellCheck={false} />
            </Field>
            <div><Button type="submit" variant="secondary" loading={pending} disabled={!allowed || !url}><Plug />Connect {title}</Button></div>
          </form>
        )}
      </CardBody>
    </Card>
  );
}

function CalendarCard({ calendars, allowed }: { calendars: Overview["calendars"]; allowed: boolean }) {
  const [pending, start] = React.useTransition();
  const row = (key: "google_workspace" | "microsoft_365", label: string, c: Overview["calendars"]["google"]) => (
    <div className="flex flex-wrap items-center gap-3">
      <Switch label={`${label}: let people connect their calendar`} checked={c.on} disabled={!allowed || !c.configured || pending}
        onCheckedChange={(on) => start(async () => { const r = await setCalendarPlaceholderAction(key, on); if (r.ok) toast.success(on ? `${label} calendar on` : `${label} calendar off`); else toast.error(r.error); })} />
      {!c.configured ? <Badge tone="warning">Not configured — add {c.hint}</Badge> : c.on ? <Badge tone="success">{c.people} {c.people === 1 ? "person" : "people"} connected</Badge> : null}
    </div>
  );
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><CalendarDays className="size-4 text-text-muted" aria-hidden />Calendars</span>} description="Interviews, 1:1s and approved leave land in people's own Google or Outlook calendars. Turn a provider on here; each person then connects their calendar under Me → Calendar & devices. The .ics download stays as a fallback." />
      <CardBody className="flex flex-col gap-3">
        {row("google_workspace", "Google Workspace", calendars.google)}
        {row("microsoft_365", "Outlook / Microsoft 365", calendars.microsoft)}
      </CardBody>
    </Card>
  );
}

function AccountingCard({ runs, allowed }: { runs: Runs; allowed: boolean }) {
  const [runId, setRunId] = React.useState(runs[0]?.id ?? "");
  const [format, setFormat] = React.useState<keyof typeof ACCOUNTING_FORMATS>("tally");
  const month = (m: string) => new Date(m + "T00:00:00Z").toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
  return (
    <Card>
      <CardHeader title="Accounting export" description="The payroll journal (salary cost against what's payable) as a CSV your accounting software can import. Finalised runs only." />
      <CardBody className="flex flex-col gap-3">
        {!allowed && <Banner tone="info">Accounting export is available on the Plus plan.</Banner>}
        {runs.length === 0 ? <EmptyState compact title="No finalised payroll runs yet" description="Once a month's payroll is finalised it appears here (payroll runners only)." /> : (
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Payroll run" className="min-w-56"><Select value={runId} onValueChange={setRunId} options={runs.map((r) => ({ value: r.id, label: `${month(r.period_month)} · ${r.pay_group}` }))} /></Field>
            <Field label="Format" className="min-w-56"><Select value={format} onValueChange={(v) => setFormat(v as keyof typeof ACCOUNTING_FORMATS)} options={Object.entries(ACCOUNTING_FORMATS).map(([k, v]) => ({ value: k, label: v }))} /></Field>
            <Button asChild variant="secondary" disabled={!allowed || !runId}><a href={allowed && runId ? `/settings/integrations/export/${runId}?format=${format}` : undefined} aria-disabled={!allowed || !runId}><Download />Download CSV</a></Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
