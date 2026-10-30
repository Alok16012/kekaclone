"use client";
import * as React from "react";
import { CheckCircle2, Lock, Paperclip, Play, RotateCcw, Send } from "lucide-react";
import { Drawer } from "@/ui/overlay";
import { Button } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Avatar } from "@/ui/avatar";
import { Field, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Segmented } from "@/ui/choice";
import { Banner, Skeleton } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { cn } from "@/lib/cn";
import { assignTicketAction, replyTicketAction, ticketDetailAction, ticketStatusAction } from "@/app/(app)/helpdesk/actions";
import { ACCEPT, ACCEPT_LABEL, MAX_UPLOAD_BYTES } from "@/server/modules/documents/rules";
import { MAX_ATTACHMENTS, type TicketAction } from "@/server/modules/helpdesk/rules";
import type { TicketDetailDTO } from "./types";
import { fmtSize, fmtWhen, PriorityBadge, SlaBadge, TicketStatusBadge } from "./bits";

const UNASSIGNED = "__none";
const ACTION: Record<TicketAction, { label: string; icon: React.ReactNode; done: string }> = {
  start: { label: "Start work", icon: <Play />, done: "Marked in progress" },
  close: { label: "Close ticket", icon: <CheckCircle2 />, done: "Ticket closed" },
  reopen: { label: "Reopen", icon: <RotateCcw />, done: "Ticket reopened" },
};

function useTicket(id: string | null) {
  const [state, setState] = React.useState<{ id: string; d?: TicketDetailDTO; error?: string } | null>(null);
  const [nonce, setNonce] = React.useState(0);
  React.useEffect(() => {
    if (!id) return;
    let live = true;
    ticketDetailAction(id).then((r) => { if (live) setState(r.ok ? { id, d: r.data } : { id, error: r.error }); });
    return () => { live = false; };
  }, [id, nonce]);
  return { d: state?.id === id ? state.d : undefined, error: state?.id === id ? state.error : undefined, reload: () => setNonce((n) => n + 1) };
}

/** One ticket: facts, SLA, the conversation and the reply box. Used by My helpdesk (requester) and the agent queue. */
export function TicketDrawer({ ticketId, onClose }: { ticketId: string | null; onClose: () => void }) {
  const { d, error, reload } = useTicket(ticketId);
  const [busy, start] = React.useTransition();
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) => start(async () => {
    const r = await fn();
    if (!r.ok) { toast.error(r.error ?? "Couldn't save."); return; }
    toast.success(ok); reload();
  });
  const agent = d?.role === "agent";
  return (
    <Drawer open={!!ticketId} onOpenChange={(o) => !o && onClose()} title={d ? `${d.ticket.ref} · ${d.ticket.title}` : "Ticket"}
      description={d ? `${d.ticket.category}${agent ? ` · raised by ${d.ticket.requester}` : ""}` : undefined}
      footer={d && d.can.actions.length > 0 && (
        <>{d.can.actions.map((a) => (
          <Button key={a} variant={a === "close" ? "primary" : "secondary"} loading={busy} onClick={() => run(() => ticketStatusAction(d.ticket.id, a), ACTION[a].done)}>{ACTION[a].icon}{ACTION[a].label}</Button>
        ))}</>
      )}>
      {error ? <Banner tone="danger" title="Couldn't open this ticket">{error}</Banner> : !d ? (
        <div className="flex flex-col gap-3" aria-busy aria-label="Loading ticket"><Skeleton className="h-6 w-1/2" /><Skeleton className="h-24" /><Skeleton className="h-40" /></div>
      ) : (
        <div className="flex flex-col gap-5">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-base">
            <div><dt className="text-sm text-text-muted">Status</dt><dd className="mt-0.5"><TicketStatusBadge status={d.ticket.status} /></dd></div>
            <div><dt className="text-sm text-text-muted">Priority</dt><dd className="mt-0.5"><PriorityBadge priority={d.ticket.priority} /></dd></div>
            <div><dt className="text-sm text-text-muted">Raised</dt><dd>{fmtWhen(d.ticket.created_at)}</dd></div>
            <div>
              <dt className="text-sm text-text-muted">Assigned to</dt>
              <dd className="mt-0.5">{agent && d.can.assign ? (
                <AssigneeSelect id={d.ticket.id} value={d.ticket.assignee_id} agents={d.agents} disabled={busy} onChange={(v) => run(() => assignTicketAction(d.ticket.id, v), v ? "Ticket assigned" : "Ticket unassigned")} />
              ) : d.ticket.assignee ?? <span className="text-text-muted">Not assigned yet</span>}</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-sm text-text-muted">Service targets</dt>
              <dd className="mt-1 flex flex-wrap gap-1.5">
                {d.ticket.sla.first === "none" && d.ticket.sla.resolution === "none" ? <span className="text-text-muted">No targets for this category</span> : (
                  <>
                    <SlaBadge clock={d.ticket.sla.first} label="First response" />
                    <SlaBadge clock={d.ticket.sla.resolution} label="Resolution" />
                  </>
                )}
              </dd>
              {(d.ticket.first_response_due_at || d.ticket.resolution_due_at) && (
                <p className="mt-1 text-sm text-text-muted">
                  {d.ticket.first_response_due_at && <>First reply due {fmtWhen(d.ticket.first_response_due_at)}{d.ticket.first_responded_at ? `, answered ${fmtWhen(d.ticket.first_responded_at)}` : ""}. </>}
                  {d.ticket.resolution_due_at && <>Resolution due {fmtWhen(d.ticket.resolution_due_at)}{d.ticket.closed_at ? `, closed ${fmtWhen(d.ticket.closed_at)}` : ""}.</>}
                  {d.ticket.reopened_count > 0 && ` Reopened ${d.ticket.reopened_count} ${d.ticket.reopened_count === 1 ? "time" : "times"}.`}
                </p>
              )}
            </div>
          </dl>

          <section aria-label="Conversation" className="flex flex-col gap-3 border-t border-border pt-4">
            <h3 className="text-sm font-semibold">Conversation</h3>
            <ol className="flex flex-col gap-3">
              {d.messages.map((m) => (
                <li key={m.id} className={cn("rounded-lg border px-3 py-2.5", m.internal ? "border-warning/40 bg-warning-soft" : m.from_agent ? "border-border bg-surface-sunken" : "border-border bg-surface")}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Avatar name={m.author ?? "Former employee"} size="xs" />
                    <span className="text-sm font-medium">{m.mine ? "You" : m.author ?? "Former employee"}</span>
                    {m.internal && <Badge tone="warning"><Lock aria-hidden />Internal note</Badge>}
                    {!m.internal && m.from_agent && agent === false && <Badge tone="accent">Helpdesk</Badge>}
                    <span className="ml-auto text-xs text-text-muted">{fmtWhen(m.created_at)}</span>
                  </div>
                  <p className="mt-1.5 whitespace-pre-line break-words text-base">{m.body}</p>
                  {m.files.length > 0 && (
                    <ul className="mt-2 flex flex-col gap-1">
                      {m.files.map((f) => (
                        <li key={f.id} className="flex items-center gap-2 text-sm">
                          <Paperclip className="size-3.5 text-text-muted" aria-hidden />
                          <a href={`/helpdesk/files/${f.id}`} target="_blank" rel="noreferrer" className="min-w-0 truncate text-accent-text hover:underline">{f.name}</a>
                          <span className="text-text-muted">{fmtSize(f.size)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          </section>

          {d.can.reply ? <Composer ticketId={d.ticket.id} canInternal={d.can.internal} onSent={reload} />
            : <p className="rounded-md bg-surface-sunken px-3 py-2 text-base text-text-muted">This ticket is closed. Reopen it if you need to add something.</p>}
        </div>
      )}
    </Drawer>
  );
}

function AssigneeSelect({ id, value, agents, disabled, onChange }: { id: string; value: string | null; agents: TicketDetailDTO["agents"]; disabled: boolean; onChange: (v: string | null) => void }) {
  return (
    <Field key={id} label={<span className="sr-only">Assigned to</span>} className="gap-0">
      <Select size="sm" disabled={disabled} value={value ?? UNASSIGNED} onValueChange={(v) => onChange(v === UNASSIGNED ? null : v)}
        options={[{ value: UNASSIGNED, label: "Not assigned" }, ...agents.map((a) => ({ value: a.id, label: a.name }))]} />
      {agents.length === 0 && <p className="mt-1 text-xs text-text-muted">Add agents to this category in Settings.</p>}
    </Field>
  );
}

function Composer({ ticketId, canInternal, onSent }: { ticketId: string; canInternal: boolean; onSent: () => void }) {
  const [mode, setMode] = React.useState<"reply" | "note">("reply");
  const [body, setBody] = React.useState("");
  const [files, setFiles] = React.useState<File[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, start] = React.useTransition();
  const fileRef = React.useRef<HTMLInputElement>(null);
  const send = (e: React.FormEvent) => {
    e.preventDefault();
    if (!body.trim()) { setError("Write a message."); return; }
    const fd = new FormData();
    fd.set("ticketId", ticketId); fd.set("body", body); fd.set("internal", mode === "note" ? "1" : "0");
    for (const f of files) fd.append("files", f);
    start(async () => {
      const r = await replyTicketAction(fd);
      if (!r.ok) { setError(r.error); return; }
      setBody(""); setFiles([]); setError(null); if (fileRef.current) fileRef.current.value = "";
      toast.success(mode === "note" ? "Note added" : "Reply sent"); onSent();
    });
  };
  const pick = (list: FileList | null) => {
    const arr = Array.from(list ?? []);
    if (arr.length > MAX_ATTACHMENTS) { setError(`Attach at most ${MAX_ATTACHMENTS} files.`); return; }
    const big = arr.find((f) => f.size > MAX_UPLOAD_BYTES);
    if (big) { setError(`${big.name} is larger than 5 MB.`); return; }
    setError(null); setFiles(arr);
  };
  return (
    <form onSubmit={send} className="flex flex-col gap-3 border-t border-border pt-4">
      {canInternal && <Segmented label="Message type" value={mode} onChange={setMode} options={[{ value: "reply", label: "Reply to requester" }, { value: "note", label: "Internal note" }]} />}
      <Field label={mode === "note" ? "Internal note" : "Your message"} help={mode === "note" ? "Only agents see internal notes." : undefined} error={error ?? undefined}>
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} rows={4} placeholder={mode === "note" ? "Notes for other agents" : "Write a reply"} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-sm text-accent-text hover:bg-surface-hover focus-within:outline-2 focus-within:outline-focus">
          <Paperclip className="size-4" aria-hidden />Attach files
          <input ref={fileRef} type="file" multiple accept={ACCEPT} className="sr-only" onChange={(e) => pick(e.target.files)} aria-describedby="composer-files-help" />
        </label>
        <span id="composer-files-help" className="text-xs text-text-muted">{files.length ? files.map((f) => f.name).join(", ") : `Up to ${MAX_ATTACHMENTS}: ${ACCEPT_LABEL}`}</span>
        <Button type="submit" className="ml-auto" loading={busy}><Send />{mode === "note" ? "Add note" : "Send"}</Button>
      </div>
    </form>
  );
}
