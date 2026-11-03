"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, ChevronDown, Clock, MoreHorizontal, Pencil, Plus, Search, Send, Upload, UserX } from "lucide-react";
import { Card } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { Checkbox, Switch } from "@/ui/choice";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Menu, Modal } from "@/ui/overlay";
import { EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { cn } from "@/lib/cn";
import { groupLabel, REJECT_REASONS, sourceLabel, type StageGroup } from "@/server/modules/hire/rules";
import type { Card as CardRow, Stage } from "@/server/modules/hire/jobs";
import type { FieldDef } from "@/server/modules/hire/setup";
import { bulkMoveAction, jobStatusAction, moveAction, rejectAction, restoreAction } from "@/app/(app)/hire/actions";
import { AddCandidateDialog, ImportDialog } from "./add-candidate";
import { JobStatusBadge, OfferBadge, Rating, when } from "./shared";

type Job = { id: string; title: string; status: string; department: string | null; location: string | null; openings: number; publish: { career_site?: boolean } };

/**
 * S137: the job's pipeline as a board, one column per stage. Cards can be dragged between columns, or moved with the
 * card's "Move to" menu (keyboard and touch friendly). Select several cards to move or reject them together.
 */
export function Pipeline({ job, stages, cards: initial, canAct, fields }: { job: Job; stages: Stage[]; cards: CardRow[]; canAct: boolean; fields: FieldDef[] }) {
  const router = useRouter();
  const [cards, setCards] = React.useState(initial);
  // After a server refresh the page hands us new cards; adopt them during render rather than in an effect.
  const [lastInitial, setLastInitial] = React.useState(initial);
  if (lastInitial !== initial) { setLastInitial(initial); setCards(initial); }
  const [q, setQ] = React.useState("");
  const [showRejected, setShowRejected] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [over, setOver] = React.useState<string | null>(null);
  const [rejecting, setRejecting] = React.useState<string[] | null>(null);
  const [adding, setAdding] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [bulkStage, setBulkStage] = React.useState("");
  const [, start] = React.useTransition();
  const [announce, setAnnounce] = React.useState("");

  const groupOf = (stageId: string) => stages.find((s) => s.id === stageId)?.stage_group;
  const cols = stages.filter((s) => showRejected || s.stage_group !== "rejected");
  const visible = cards.filter((c) => !q || `${c.name} ${c.email} ${c.current_company ?? ""} ${c.tags.join(" ")}`.toLowerCase().includes(q.toLowerCase()));
  const movable = (s: Stage) => s.stage_group !== "rejected" && s.stage_group !== "hired";

  const move = (card: CardRow, stage: Stage) => {
    if (card.stage_id === stage.id) return;
    if (!movable(stage)) { toast.error(stage.stage_group === "rejected" ? "Use Reject so a reason is recorded." : "Candidates reach Hired when their accepted offer is converted."); return; }
    const before = cards;
    setCards((cs) => cs.map((c) => (c.id === card.id ? { ...c, stage_id: stage.id, days_in_stage: 0 } : c)));
    setAnnounce(`${card.name} moved to ${stage.name}`);
    start(async () => {
      const r = await moveAction(card.id, stage.id);
      if (!r.ok) { setCards(before); toast.error(r.error); } else toast.success(`${card.name} moved to ${stage.name}`);
    });
  };
  const bulkMove = () => start(async () => {
    const ids = [...selected];
    const r = await bulkMoveAction(ids, bulkStage);
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(`${r.data!.moved} moved${r.data!.failed.length ? `, ${r.data!.failed.length} couldn't be moved` : ""}`, { description: r.data!.failed[0]?.error });
    setSelected(new Set()); setBulkStage("");
  });
  const status = (action: "publish" | "hold" | "reopen" | "close") => start(async () => {
    const r = await jobStatusAction(job.id, action);
    if (!r.ok) toast.error(r.error); else toast.success({ publish: "Job published", hold: "Job on hold", reopen: "Job reopened", close: "Job closed" }[action]);
  });
  const toggle = (id: string, on: boolean) => setSelected((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });

  const jobMenu = [
    ...(job.status === "draft" ? [{ label: "Publish", onSelect: () => status("publish") }] : []),
    ...(job.status === "open" ? [{ label: "Put on hold", onSelect: () => status("hold") }] : []),
    ...(job.status === "on_hold" || job.status === "closed" ? [{ label: "Reopen", onSelect: () => status("reopen") }] : []),
    ...(job.status !== "closed" ? [{ label: "Close job", danger: true, onSelect: () => status("close") }] : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
          <JobStatusBadge status={job.status} />
          <span>{[job.department, job.location, `${job.openings} ${job.openings === 1 ? "opening" : "openings"}`].filter(Boolean).join(" · ")}</span>
          {job.publish.career_site && job.status === "open" && <Link href={`/careers/${job.id}`} target="_blank" className="text-accent-text hover:underline">View on careers page<span className="sr-only"> (opens in a new tab)</span></Link>}
        </div>
        <div className="flex flex-wrap gap-2 lg:ml-auto">
          {canAct && job.status !== "closed" && <Button size="sm" onClick={() => setAdding(true)}><Plus />Add candidate</Button>}
          {canAct && job.status !== "closed" && <Button size="sm" variant="secondary" onClick={() => setImporting(true)}><Upload />Import</Button>}
          {canAct && <Button asChild size="sm" variant="secondary"><Link href={`/hire/jobs/${job.id}/edit`}><Pencil />Edit job</Link></Button>}
          {canAct && jobMenu.length > 0 && <Menu trigger={<Button size="sm" variant="secondary">Status<ChevronDown /></Button>} items={jobMenu} />}
        </div>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <Input leading={<Search />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name, company or tag" aria-label="Filter candidates" className="sm:w-72" />
        <Switch checked={showRejected} onCheckedChange={(c) => setShowRejected(!!c)} label={`Show rejected (${cards.filter((c) => groupOf(c.stage_id) === "rejected").length})`} />
      </div>

      {canAct && selected.size > 0 && (
        <div role="region" aria-label="Bulk actions" className="flex flex-col gap-2 rounded-md bg-accent-soft px-3 py-2 text-accent-text sm:flex-row sm:items-center">
          <span className="font-medium tabular">{selected.size} selected</span>
          <div className="flex flex-wrap gap-2 sm:ml-auto">
            <Select size="sm" value={bulkStage} onValueChange={setBulkStage} placeholder="Move to…" options={stages.filter(movable).map((s) => ({ value: s.id, label: s.name }))} className="w-44" />
            <Button size="sm" disabled={!bulkStage} onClick={bulkMove}>Move</Button>
            <Button size="sm" variant="danger" onClick={() => setRejecting([...selected])}><UserX />Reject</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
        </div>
      )}
      <p aria-live="polite" className="sr-only">{announce}</p>

      {cards.length === 0 ? (
        <Card><EmptyState title="No candidates yet" description={canAct ? "Add candidates yourself, import a sheet, or publish the job so people can apply." : "Candidates for this job will show up here."}
          action={canAct ? <Button onClick={() => setAdding(true)}><Plus />Add candidate</Button> : undefined} /></Card>
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
          <div className="flex snap-x snap-mandatory gap-3" style={{ minWidth: `${cols.length * 17}rem` }}>
            {cols.map((s) => {
              const inCol = visible.filter((c) => c.stage_id === s.id);
              const allSel = inCol.length > 0 && inCol.every((c) => selected.has(c.id));
              return (
                <section key={s.id} aria-label={`${s.name}, ${inCol.length} candidates`}
                  onDragOver={(e) => { if (dragging && canAct) { e.preventDefault(); setOver(s.id); } }} onDragLeave={() => setOver((o) => (o === s.id ? null : o))}
                  onDrop={(e) => { e.preventDefault(); setOver(null); const c = cards.find((x) => x.id === dragging); setDragging(null); if (c) move(c, s); }}
                  className={cn("flex w-68 shrink-0 snap-start flex-col rounded-lg border border-border bg-surface-sunken", over === s.id && "border-accent ring-2 ring-accent/30")}>
                  <header className="flex items-center gap-2 border-b border-border px-3 py-2">
                    {canAct && inCol.length > 0 && <Checkbox aria-label={`Select everyone in ${s.name}`} checked={allSel} onCheckedChange={(c) => inCol.forEach((x) => toggle(x.id, !!c))} />}
                    <h3 className="min-w-0 flex-1 truncate text-base font-semibold">{s.name}</h3>
                    <Badge>{inCol.length}</Badge>
                  </header>
                  <p className="px-3 pt-1 text-xs text-text-muted">{groupLabel(s.stage_group)}</p>
                  <ul className="flex min-h-24 flex-col gap-2 p-2">
                    {inCol.map((c) => (
                      <li key={c.id} draggable={canAct && c.status === "active"} onDragStart={(e) => { setDragging(c.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", c.id); }} onDragEnd={() => { setDragging(null); setOver(null); }}
                        className={cn("rounded-md border border-border bg-surface p-3 shadow-card", canAct && c.status === "active" && "cursor-grab active:cursor-grabbing", dragging === c.id && "opacity-50", selected.has(c.id) && "ring-2 ring-accent/40")}>
                        <div className="flex items-start gap-2">
                          {canAct && <Checkbox aria-label={`Select ${c.name}`} checked={selected.has(c.id)} onCheckedChange={(v) => toggle(c.id, !!v)} className="mt-0.5" />}
                          <div className="min-w-0 flex-1">
                            <Link href={`/hire/candidates/${c.candidate_id}?app=${c.id}`} className="block truncate text-base font-medium hover:underline">{c.name}</Link>
                            <p className="truncate text-sm text-text-muted">{[c.current_title, c.current_company].filter(Boolean).join(" at ") || c.email}</p>
                          </div>
                          {canAct && <CardMenu card={c} stages={stages} onMove={(st) => move(c, st)} onReject={() => setRejecting([c.id])} onRestore={() => start(async () => { const r = await restoreAction(c.id); if (r.ok) toast.success(`${c.name} restored`); else toast.error(r.error); })} />}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                          <Rating value={c.rating} count={c.ratings} />
                          <span className="inline-flex items-center gap-1"><Clock aria-hidden className="size-3" />{c.days_in_stage === 0 ? "Today" : `${c.days_in_stage}d in stage`}</span>
                          <span>{c.referred_by ? `Referred by ${c.referred_by}` : sourceLabel(c.source)}</span>
                        </div>
                        {(c.next_interview || c.offer_status) && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {c.next_interview && <Badge tone="accent"><CalendarClock aria-hidden />{when(c.next_interview)}</Badge>}
                            {c.offer_status && <OfferBadge status={c.offer_status} />}
                          </div>
                        )}
                      </li>
                    ))}
                    {inCol.length === 0 && <li className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-text-muted">{dragging ? "Drop here" : "No one here"}</li>}
                  </ul>
                </section>
              );
            })}
          </div>
        </div>
      )}
      {rejecting && <RejectDialog ids={rejecting} names={cards.filter((c) => rejecting.includes(c.id)).map((c) => c.name)} onClose={(done) => { setRejecting(null); if (done) setSelected(new Set()); router.refresh(); }} />}
      <AddCandidateDialog open={adding} onClose={() => setAdding(false)} jobId={job.id} jobTitle={job.title} fields={fields} />
      <ImportDialog open={importing} onClose={() => setImporting(false)} jobId={job.id} />
    </div>
  );
}

function CardMenu({ card, stages, onMove, onReject, onRestore }: { card: CardRow; stages: Stage[]; onMove: (s: Stage) => void; onReject: () => void; onRestore: () => void }) {
  if (card.status !== "active") {
    return card.status === "rejected" ? <Menu trigger={<IconButton size="icon-sm" label={`Actions for ${card.name}`}><MoreHorizontal /></IconButton>} items={[{ label: "Bring back", onSelect: onRestore }]} /> : null;
  }
  return (
    <Menu trigger={<IconButton size="icon-sm" label={`Move ${card.name}`}><MoreHorizontal /></IconButton>} items={[
      ...stages.filter((s) => s.stage_group !== "rejected" && s.stage_group !== "hired" && s.id !== card.stage_id).map((s) => ({ label: `Move to ${s.name}`, icon: <Send />, onSelect: () => onMove(s) })),
      "separator" as const,
      { label: "Reject…", icon: <UserX />, danger: true, onSelect: onReject },
    ]} />
  );
}

export function RejectDialog({ ids, names, onClose }: { ids: string[]; names: string[]; onClose: (done: boolean) => void }) {
  const [reason, setReason] = React.useState<string>("");
  const [other, setOther] = React.useState("");
  const [note, setNote] = React.useState("");
  const [email, setEmail] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, start] = React.useTransition();
  return (
    <Modal open onOpenChange={(o) => !o && onClose(false)} title={ids.length === 1 ? `Reject ${names[0] ?? "candidate"}?` : `Reject ${ids.length} candidates?`}
      description="They move out of the process. You can bring them back later."
      footer={<><Button variant="secondary" onClick={() => onClose(false)}>Cancel</Button><Button variant="danger" loading={busy} onClick={() => start(async () => {
        const why = reason === "Other" ? other.trim() || "Other" : reason;
        if (!why) { setError("Pick a reason."); return; }
        const r = await rejectAction(ids, why, email, note);
        if (!r.ok) { setError(r.error); return; }
        toast.success(`${r.data!.rejected} rejected${r.data!.failed.length ? `, ${r.data!.failed.length} skipped` : ""}`);
        onClose(true);
      })}>Reject</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="Reason" required error={error ?? undefined}><Select value={reason} onValueChange={setReason} placeholder="Pick a reason" options={REJECT_REASONS.map((r) => ({ value: r, label: r }))} /></Field>
        {reason === "Other" && <Field label="Describe the reason"><Input value={other} onChange={(e) => setOther(e.target.value)} maxLength={200} /></Field>}
        <Field label="Note for the team" help="Not shared with the candidate"><Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></Field>
        <Switch checked={email} onCheckedChange={(c) => setEmail(!!c)} label="Email the candidate (uses the “Not moving forward” template)" />
      </div>
    </Modal>
  );
}

export type { StageGroup };
