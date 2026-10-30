"use client";
import * as React from "react";
import Link from "next/link";
import { CalendarClock, CheckCircle2, Circle, FileText, Download, MinusCircle, MoreHorizontal, Wallet } from "lucide-react";
import { Drawer, ConfirmDialog, Menu } from "@/ui/overlay";
import { Button, IconButton } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Avatar } from "@/ui/avatar";
import { Checkbox } from "@/ui/choice";
import { Field, Input, Textarea } from "@/ui/field";
import { Banner, Progress, Skeleton } from "@/ui/feedback";
import { ApprovalTimeline } from "@/ui/flow";
import { toast } from "@/ui/toast";
import { cancelExitAction, completeExitAction, decideExitAction, exitDetailAction, setExitTaskAction, updateExitAction } from "@/app/(app)/org/exits/actions";
import { generateLetterAction } from "@/app/(app)/org/documents/actions";
import type { ExitDetail } from "@/server/modules/exits/service";

export const fmtDate = (d: string | null | undefined) => (d ? new Date(d.slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");
export const STATUS_LABEL: Record<string, { label: string; tone: "warning" | "accent" | "success" | "neutral" | "danger" }> = {
  under_review: { label: "Under review", tone: "warning" }, in_progress: { label: "Serving notice", tone: "accent" }, exited: { label: "Exited", tone: "neutral" },
  withdrawn: { label: "Withdrawn", tone: "neutral" }, rejected: { label: "Declined", tone: "danger" },
};
const KIND = { resignation: "Resignation", company_action: "Company action" };

/** Loads one exit's detail; re-fetches after each change. */
export function useExitDetail(exitId: string | null) {
  const [state, setState] = React.useState<{ id: string; detail?: ExitDetail; error?: string } | null>(null);
  const [nonce, setNonce] = React.useState(0);
  React.useEffect(() => {
    if (!exitId) return;
    let live = true;
    exitDetailAction(exitId).then((r) => { if (live) setState(r.ok ? { id: exitId, detail: r.data } : { id: exitId, error: r.error }); });
    return () => { live = false; };
  }, [exitId, nonce]);   // state is keyed by id, so a new id shows the loading state; a reload keeps the old data until the new arrives
  return { detail: state?.id === exitId ? state?.detail : undefined, error: state?.id === exitId ? state?.error : undefined, reload: () => setNonce((n) => n + 1) };
}

/** Facts about an exit; shared by the drawer and the Inbox. */
export function ExitSummary({ d }: { d: ExitDetail }) {
  const x = d.exit;
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-base">
      <div><dt className="text-sm text-text-muted">Type</dt><dd className="font-medium">{KIND[x.kind]}</dd></div>
      <div><dt className="text-sm text-text-muted">Status</dt><dd><Badge tone={STATUS_LABEL[x.status].tone}>{STATUS_LABEL[x.status].label}</Badge></dd></div>
      <div><dt className="text-sm text-text-muted">Resignation date</dt><dd className="font-medium">{fmtDate(x.resignation_date)}</dd></div>
      <div><dt className="text-sm text-text-muted">Last working day</dt><dd className="font-medium">{fmtDate(x.last_working_date)}</dd></div>
      <div className="col-span-2"><dt className="text-sm text-text-muted">Notice period</dt>
        <dd>{d.notice.policy ? `${d.notice.policy} · ${d.notice.days} days` : "No notice period set"}{x.notice_waived_days > 0 ? ` · ${x.notice_waived_days} ${x.notice_waived_days === 1 ? "day" : "days"} waived` : ""}
          {x.requested_lwd && x.requested_lwd !== x.last_working_date ? <span className="block text-sm text-text-muted">Asked for {fmtDate(x.requested_lwd)}</span> : null}</dd></div>
      <div><dt className="text-sm text-text-muted">Reason</dt><dd>{x.reason ?? <span className="text-text-muted">Not given</span>}</dd></div>
      <div><dt className="text-sm text-text-muted">OK to rehire</dt><dd>{x.ok_to_rehire == null ? <span className="text-text-muted">Not decided</span> : x.ok_to_rehire ? "Yes" : "No"}</dd></div>
      {x.comments && <div className="col-span-2"><dt className="text-sm text-text-muted">Comments</dt><dd className="mt-1 whitespace-pre-line rounded-md bg-surface-sunken px-3 py-2">{x.comments}</dd></div>}
    </dl>
  );
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-4">
      <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold">{title}</h3>{action}</div>
      {children}
    </section>
  );
}

export function ExitDrawer({ exitId, onClose, letterTemplates, today }: { exitId: string | null; onClose: () => void; letterTemplates: { id: string; name: string; kind: string }[]; today: string }) {
  const { detail: d, error, reload } = useExitDetail(exitId);
  const [busy, start] = React.useTransition();
  const [editingLwd, setEditingLwd] = React.useState<string | null>(null);
  const [comment, setComment] = React.useState("");
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string, close = false) => start(async () => {
    const r = await fn();
    if (!r.ok) { toast.error(r.error ?? "Couldn't save."); return; }
    toast.success(ok);
    if (close) onClose(); else reload();
  });
  const done = d ? d.tasks.filter((t) => t.status === "done").length : 0;
  const active = d ? d.tasks.filter((t) => t.status !== "skipped").length : 0;
  const exitLetters = letterTemplates.filter((t) => t.kind === "relieving" || t.kind === "experience");

  return (
    <Drawer open={!!exitId} onOpenChange={(o) => { if (!o) { setEditingLwd(null); setComment(""); onClose(); } }}
      title={d?.employee.name ?? "Exit"} description={d ? [d.employee.designation, d.employee.department].filter(Boolean).join(" · ") || d.employee.number : undefined}
      footer={d && (d.can.decide ? (
        <><Button variant="danger" loading={busy} onClick={() => run(() => decideExitAction(d.exit.id, "rejected", comment), "Resignation declined", true)}>Decline</Button>
          <Button loading={busy} onClick={() => run(() => decideExitAction(d.exit.id, "approved", comment), "Resignation accepted. The exit checklist has started.")}>Accept resignation</Button></>
      ) : d.can.manage && d.exit.status === "in_progress" ? (
        <>
          <ConfirmDialog title="Cancel this exit?" description={`${d.employee.name} stays with the company. Open checklist tasks are skipped.`} confirmLabel="Cancel exit"
            onConfirm={() => run(() => cancelExitAction(d.exit.id), "Exit cancelled", true)} trigger={<Button variant="secondary">Cancel exit</Button>} />
          <ConfirmDialog tone="primary" title={`Complete ${d.employee.name}'s exit?`} description="They'll be marked as relieved, can no longer sign in, and are signed out everywhere now." confirmLabel="Complete exit"
            onConfirm={() => run(() => completeExitAction(d.exit.id), "Exit completed", true)}
            trigger={<Button disabled={!d.can.complete} title={d.can.complete ? undefined : "Available from the last working day"}>Complete exit</Button>} />
        </>
      ) : undefined)}>
      {error ? <Banner tone="danger" title="Couldn't load this exit">{error}</Banner> : !d ? (
        <div className="flex flex-col gap-3" aria-busy aria-label="Loading exit"><Skeleton className="h-6 w-1/2" /><Skeleton className="h-28" /><Skeleton className="h-40" /></div>
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-3">
            <Avatar name={d.employee.name} />
            <div className="min-w-0 text-base"><Link href={`/people/${d.employee.id}`} className="font-medium hover:underline">{d.employee.name}</Link>
              <p className="text-sm text-text-muted">{d.employee.number} · joined {fmtDate(d.employee.joining_date)}{d.employee.manager ? ` · reports to ${d.employee.manager}` : ""}</p></div>
          </div>
          <ExitSummary d={d} />
          {d.can.manage && (d.exit.status === "in_progress" || d.exit.status === "under_review") && (
            editingLwd == null ? (
              <Button variant="secondary" size="sm" className="self-start" onClick={() => setEditingLwd(d.exit.last_working_date)}><CalendarClock />Change last working day</Button>
            ) : (
              <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); run(() => updateExitAction(d.exit.id, { lastWorkingDate: editingLwd }), "Last working day updated"); setEditingLwd(null); }}>
                <Field label="Last working day" help={`Notice period ends ${fmtDate(d.notice.lastWorkingDate)}`}><Input type="date" required min={d.exit.resignation_date} value={editingLwd} onChange={(e) => setEditingLwd(e.target.value)} /></Field>
                <Button type="submit" size="md" loading={busy}>Save</Button><Button variant="ghost" onClick={() => setEditingLwd(null)}>Cancel</Button>
              </form>
            )
          )}
          {d.can.decide && <Field label="Comment" help="Shared with the employee"><Textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} /></Field>}

          {d.approvals.length > 0 && (
            <Section title="Approvals">
              <ApprovalTimeline levels={d.approvals.map((s) => ({ level: s.level, approver: s.approver, role: s.title ?? undefined, status: s.status === "skipped" ? "waiting" : s.status, comment: s.comment ?? undefined, at: s.acted_at ? new Date(s.acted_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : undefined }))} />
            </Section>
          )}

          <Section title={`Exit checklist${active ? ` · ${done} of ${active} done` : ""}`}>
            {d.tasks.length === 0 ? (
              <p className="text-base text-text-muted">{d.exit.status === "under_review" ? "The checklist starts once the resignation is accepted." : "No checklist for this exit."}</p>
            ) : (
              <>
                <Progress value={done} max={Math.max(1, active)} label="Checklist progress" tone={done === active ? "success" : "accent"} />
                <ul className="flex flex-col divide-y divide-border">
                  {d.tasks.map((t) => {
                    const canTick = (d.can.manage || t.mine) && d.exit.status === "in_progress" && t.status !== "skipped";
                    const overdue = t.status === "open" && t.due_date && t.due_date < today;
                    return (
                      <li key={t.id} className="flex items-start gap-3 py-2.5">
                        {canTick ? (
                          <Checkbox className="mt-1" aria-label={`Mark "${t.title}" ${t.status === "done" ? "not done" : "done"}`} checked={t.status === "done"} disabled={busy}
                            onCheckedChange={(c) => run(() => setExitTaskAction(t.id, c ? "done" : "open"), c ? "Task done" : "Task reopened")} />
                        ) : t.status === "done" ? <CheckCircle2 className="mt-0.5 size-4 text-success" aria-label="Done" /> : t.status === "skipped" ? <MinusCircle className="mt-0.5 size-4 text-text-muted" aria-label="Skipped" /> : <Circle className="mt-0.5 size-4 text-text-muted" aria-label="Open" />}
                        <div className="min-w-0 flex-1">
                          <p className={t.status === "skipped" ? "text-base text-text-muted line-through" : "text-base font-medium"}>{t.title}</p>
                          {t.description && <p className="text-sm text-text-muted">{t.description}</p>}
                          <p className="mt-0.5 text-sm text-text-muted">{t.owner}{t.assignee ? ` · ${t.assignee}` : " · no one assigned"} · due {fmtDate(t.due_date)}{overdue && <Badge tone="danger" className="ml-1.5">Overdue</Badge>}</p>
                        </div>
                        {d.can.manage && t.status !== "done" && d.exit.status === "in_progress" && (
                          <Menu trigger={<IconButton size="icon-sm" label={`More for ${t.title}`}><MoreHorizontal /></IconButton>}
                            items={[t.status === "skipped" ? { label: "Bring back", onSelect: () => run(() => setExitTaskAction(t.id, "open"), "Task reopened") } : { label: "Skip this task", onSelect: () => run(() => setExitTaskAction(t.id, "skipped"), "Task skipped") }]} />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </Section>

          <Section title="Final settlement">
            <div className="flex items-start gap-3 rounded-md bg-surface-sunken px-3 py-3 text-base">
              <Wallet className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden />
              <p className="text-text-muted">{"Full and final settlement will be worked out in payroll once it's available. Use the “Final settlement” task to track it until then."}</p>
            </div>
          </Section>

          {(d.can.manage || d.letters.length > 0) && (
            <Section title="Letters" action={d.can.manage && exitLetters.length > 0 && d.exit.status !== "under_review" ? (
              <Menu trigger={<Button variant="secondary" size="sm"><FileText />Issue a letter</Button>}
                items={exitLetters.map((t) => ({ label: t.name, onSelect: () => run(() => generateLetterAction(t.id, d.employee.id), `${t.name} added to ${d.employee.name}'s documents`) }))} />
            ) : undefined}>
              {d.letters.length === 0 ? <p className="text-base text-text-muted">{exitLetters.length ? "No letters issued yet. Relieving and experience letters are saved to the person's Documents." : <>No letter templates yet. <Link href="/settings/documents" className="text-accent-text hover:underline">Create one in Settings</Link>.</>}</p> : (
                <ul className="flex flex-col gap-2">
                  {d.letters.map((l) => (
                    <li key={l.id} className="flex items-center gap-3 text-base">
                      <FileText className="size-4 text-text-muted" aria-hidden />
                      <a href={`/files/${l.file_id}`} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate hover:underline">{l.title}</a>
                      <span className="text-sm text-text-muted">{fmtDate(l.created_at)}</span>
                      <IconButton asChild size="icon-sm" label={`Download ${l.title}`}><a href={`/files/${l.file_id}?download=1`}><Download /></a></IconButton>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}
          <p className="text-sm text-text-muted">Started {fmtDate(d.exit.created_at)}{d.exit.initiated_by ? ` by ${d.exit.initiated_by}` : ""}.</p>
        </div>
      )}
    </Drawer>
  );
}
