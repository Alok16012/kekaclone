"use client";
import * as React from "react";
import Link from "next/link";
import { Ban, Copy, Link2, Mail } from "lucide-react";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Banner, EmptyState, Progress } from "@/ui/feedback";
import { ConfirmDialog, Modal } from "@/ui/overlay";
import { Input } from "@/ui/field";
import { Segmented } from "@/ui/choice";
import { toast } from "@/ui/toast";
import type { Person } from "@/ui/employee-picker";
import { cancelOnboardingAction, portalLinkAction } from "@/app/(app)/org/onboarding/actions";
import type { ProcessDetail } from "@/server/modules/onboarding/service";
import { TaskItem } from "./task-item";

const fmt = (d: string) => new Date(d.length === 10 ? d + "T00:00:00Z" : d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: d.length === 10 ? "UTC" : "Asia/Kolkata" });
const STATUS = { in_progress: { label: "In progress", tone: "accent" }, completed: { label: "Completed", tone: "success" }, cancelled: { label: "Cancelled", tone: "neutral" } } as const;

export function ProcessView({ d, people }: { d: ProcessDetail; people: Person[] }) {
  const [filter, setFilter] = React.useState<"all" | "open" | "overdue">("all");
  const tasks = d.tasks.filter((t) => filter === "all" || (filter === "open" ? t.status === "open" : t.overdue));
  const s = STATUS[d.status];
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardBody className="flex flex-col gap-4 pt-5 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <Avatar name={d.employee.name} size="lg" />
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-lg font-semibold">
                <Link href={`/people/${d.employee.id}`} className="truncate hover:underline">{d.employee.name}</Link>
                <Badge tone={s.tone}>{s.label}</Badge>
                {d.employee.status === "preboarding" && <Badge tone="accent">Preboarding</Badge>}
              </p>
              <p className="truncate text-sm text-text-muted">{[d.employee.designation, d.employee.department, d.employee.manager ? `Reports to ${d.employee.manager}` : null].filter(Boolean).join(" · ")}</p>
              <p className="text-sm text-text-muted">Joining {fmt(d.employee.joining_date)} · {d.template ?? "Checklist"}</p>
            </div>
          </div>
          <div className="sm:w-64">
            <div className="mb-1 flex justify-between text-sm"><span className="text-text-muted">{d.progress.done} of {d.progress.total} done</span><span className="tabular font-medium">{d.progress.pct}%</span></div>
            <Progress value={d.progress.done} max={Math.max(1, d.progress.total)} label="Onboarding progress" tone={d.progress.overdue ? "warning" : d.status === "completed" ? "success" : "accent"} />
            {d.progress.overdue > 0 && <p className="mt-1 text-sm text-danger-text">{d.progress.overdue} overdue</p>}
          </div>
        </CardBody>
      </Card>

      {d.can.manage && <PortalCard d={d} />}

      <Card>
        <CardHeader title="Tasks" description="Owners see their tasks in My tasks; the joiner sees theirs on Home and in their portal."
          action={<Segmented label="Show" value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "open", label: "Open" }, { value: "overdue", label: "Overdue" }]} />} />
        {tasks.length === 0 ? <EmptyState compact title={filter === "all" ? "No tasks in this checklist" : "Nothing here"} description={filter === "all" ? "The template had no tasks when onboarding started." : undefined} /> : (
          <ul className="divide-y divide-border border-t border-border">
            {tasks.map((t) => <TaskItem key={t.id} task={t} people={people} subjectId={d.employee.id} />)}
          </ul>
        )}
      </Card>

      {d.can.manage && (
        <div>
          <ConfirmDialog title="Cancel this onboarding?" description="Open tasks stop showing for their owners. You can start onboarding again later; it creates a fresh checklist."
            confirmLabel="Cancel onboarding" onConfirm={async () => { const r = await cancelOnboardingAction(d.id); if (r.ok) toast.success("Onboarding cancelled"); else toast.error(r.error); }}
            trigger={<Button variant="ghost" size="sm" className="text-danger-text"><Ban />Cancel onboarding</Button>} />
        </div>
      )}
    </div>
  );
}

function PortalCard({ d }: { d: ProcessDetail }) {
  const [url, setUrl] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const make = (email: boolean) => start(async () => {
    const r = await portalLinkAction(d.id, email);
    if (!r.ok) { toast.error(r.error); return; }
    setUrl(r.data!.url);
    if (email) toast.success(`Link emailed to ${r.data!.emailedTo}`);
  });
  return (
    <Card>
      <CardHeader title="Joiner portal" description={`${d.employee.first_name} can finish their own tasks from a private link, without signing in. A new link replaces the old one.`} />
      <CardBody className="flex flex-col gap-3">
        {d.portal.active && d.portal.expires_at && <Banner tone="info">A link is active until {fmt(d.portal.expires_at)}.</Banner>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" loading={pending} onClick={() => make(false)}><Link2 />Create link</Button>
          <Button size="sm" variant="secondary" loading={pending} onClick={() => make(true)} disabled={!d.employee.personal_email}><Mail />Email link{d.employee.personal_email ? ` to ${d.employee.personal_email}` : ""}</Button>
        </div>
        {!d.employee.personal_email && <p className="text-sm text-text-muted">Add a personal email on {d.employee.first_name}&apos;s profile to email the link.</p>}
      </CardBody>
      {url && (
        <Modal open onOpenChange={(o) => !o && setUrl(null)} size="sm" title="Portal link" description="Shown once. Share it only with the joiner."
          footer={<Button onClick={() => { navigator.clipboard.writeText(url).then(() => toast.success("Link copied"), () => toast.error("Couldn't copy; select the link instead")); }}><Copy />Copy link</Button>}>
          <Input readOnly value={url} aria-label="Portal link" onFocus={(e) => e.currentTarget.select()} />
        </Modal>
      )}
    </Card>
  );
}
