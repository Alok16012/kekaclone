"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Send, Undo2, Users } from "lucide-react";
import { COMP_STATUS_LABEL, pctText, type CompStatus, type MatrixRow } from "@/server/modules/performance/rules";
import { Card, CardBody, CardHeader, StatTile } from "@/ui/card";
import { Button } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { ConfirmDialog, Modal } from "@/ui/overlay";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { DataTable, type Column } from "@/ui/table";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import {
  applyCycleAction, closeRecommendationsAction, deleteCompCycleAction, markApprovedAction, openRecommendationsAction, recommendAction, submitRecommendationsAction,
  updateCompCycleAction, withdrawRecommendationAction,
} from "@/app/(app)/compensation/actions";
import { fromMatrix, MatrixEditor, toMatrix, TONE } from "./comp-list";
import { fmtDate, inr } from "./bits";

type Row = {
  id: string; employee_id: string; name: string; department: string | null; designation: string | null; current: number; proposed: number; rating: number | null; increment_bp: number;
  status: "draft" | "submitted" | "approved" | "rejected" | "applied"; recommended_by: string | null; recommender: string | null; note: string | null; arrears_from_month: string | null;
  apply_error: string | null; range: [number, number] | null; canEdit: boolean;
};
type D = {
  cycle: { id: string; name: string; reviewCycleId: string | null; effectiveFrom: string; budgetPaise: number | null; matrix: MatrixRow[]; status: CompStatus; appliedAt: string | null };
  isAdmin: boolean; totals: { currentPaise: number; usedPaise: number; people: number; pct: number }; team: { poolPaise: number | null; usedPaise: number; people: number };
  rows: Row[]; reviewCycles: { id: string; name: string; status: string }[];
};
const STATUS: Record<Row["status"], { label: string; tone: "neutral" | "warning" | "success" | "danger" | "accent" }> = {
  draft: { label: "Not sent", tone: "neutral" }, submitted: { label: "Waiting for approval", tone: "warning" }, approved: { label: "Approved", tone: "success" }, rejected: { label: "Declined", tone: "danger" }, applied: { label: "In payroll", tone: "accent" },
};

export function CompDetail({ d }: { d: D }) {
  const router = useRouter();
  const c = d.cycle;
  const [editing, setEditing] = React.useState<Row | null>(null);
  const [filter, setFilter] = React.useState("all");
  const [applied, setApplied] = React.useState<{ applied: number; arrears: number; failed: { name: string; error: string }[] } | null>(null);
  const mineToSend = d.rows.filter((r) => r.canEdit);
  const over = d.team.poolPaise != null && d.team.usedPaise > d.team.poolPaise;
  const overAll = c.budgetPaise != null && d.totals.usedPaise > c.budgetPaise;
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) => { const r = await fn(); if (r.ok) toast.success(ok); else toast.error(r.error ?? "Couldn't do that."); };
  const rows = d.rows.filter((r) => filter === "all" || r.status === filter);
  const cols: Column<Row>[] = [
    { key: "name", header: "Person", cell: (r) => <div><p className="font-medium">{r.name}</p><p className="text-xs text-text-muted">{r.designation ?? ""}{r.department ? ` · ${r.department}` : ""}</p></div>, sortValue: (r) => r.name },
    { key: "rating", header: "Rating", align: "right", cell: (r) => r.rating ?? "—", sortValue: (r) => r.rating ?? -1 },
    { key: "current", header: "Current CTC", align: "right", cell: (r) => inr(r.current), sortValue: (r) => r.current, hideBelow: "md" },
    { key: "inc", header: "Increment", align: "right", cell: (r) => <div><p className="font-medium tabular">{pctText(r.increment_bp)}</p>{r.range && <p className="text-xs text-text-muted">guide {r.range[0]}–{r.range[1]}%</p>}</div>, sortValue: (r) => r.increment_bp },
    { key: "new", header: "New CTC", align: "right", cell: (r) => inr(r.proposed), sortValue: (r) => r.proposed, hideBelow: "md" },
    { key: "status", header: "Status", cell: (r) => <div className="flex flex-col items-start gap-1"><Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>{r.arrears_from_month && <span className="text-xs text-text-muted">arrears from {fmtDate(r.arrears_from_month)}</span>}{r.apply_error && <span className="text-xs text-danger-text">{r.apply_error}</span>}</div> },
    { key: "act", header: <span className="sr-only">Actions</span>, cell: (r) => r.canEdit ? <Button size="sm" variant="secondary" onClick={(e) => { e.stopPropagation(); setEditing(r); }}>Change</Button>
      : r.status === "submitted" && c.status === "recommending" ? <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); void run(() => withdrawRecommendationAction(r.id), "Withdrawn"); }}><Undo2 />Withdraw</Button> : null },
  ];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={TONE[c.status]} size="md">{COMP_STATUS_LABEL[c.status]}</Badge>
        {d.isAdmin && (
          <div className="ml-auto flex flex-wrap gap-2">
            {c.status === "draft" && <>
              <ConfirmDialog trigger={<Button variant="ghost">Delete</Button>} title="Delete this draft cycle?" description="Nothing has been shared yet." confirmLabel="Delete"
                onConfirm={async () => { const r = await deleteCompCycleAction(c.id); if (r.ok) router.push("/compensation"); else toast.error(r.error); }} />
              <ConfirmDialog trigger={<Button>Open for recommendations</Button>} tone="primary" title="Open for recommendations?" confirmLabel="Open"
                description="Everyone with a salary gets a proposal pre-filled from the guide, and managers are asked to recommend for their teams." onConfirm={() => run(() => openRecommendationsAction(c.id), "Managers can now recommend")} />
            </>}
            {c.status === "recommending" && <>
              <Button variant="secondary" onClick={() => run(() => openRecommendationsAction(c.id), "Added anyone new")}>Add new joiners</Button>
              <ConfirmDialog trigger={<Button>Close recommendations</Button>} tone="primary" title="Close recommendations?" confirmLabel="Close"
                description="Managers can't change or send anything after this. Unsent proposals at 0% are left out." onConfirm={() => run(() => closeRecommendationsAction(c.id), "Recommendations closed")} />
            </>}
            {c.status === "approving" && <ConfirmDialog trigger={<Button>Mark as approved</Button>} tone="primary" title="Mark the cycle as approved?" confirmLabel="Mark approved"
              description="Do this once every recommendation is decided." onConfirm={() => run(() => markApprovedAction(c.id), "Approved")} />}
            {(c.status === "approved" || c.status === "applied") && d.rows.some((r) => r.status === "approved") && <ConfirmDialog trigger={<Button><CheckCircle2 />Apply to payroll</Button>} tone="primary" confirmLabel="Apply"
              title="Apply approved raises to payroll?" description={`Each becomes a salary revision from ${fmtDate(c.effectiveFrom)} on the person's current structure. Months already paid get arrears in the next run.`}
              onConfirm={async () => { const r = await applyCycleAction(c.id); if (r.ok) { setApplied(r.data!); toast.success(`Applied ${r.data!.applied}`); } else toast.error(r.error); }} />}
          </div>
        )}
      </div>
      {applied && (
        <Banner tone={applied.failed.length ? "warning" : "success"} title={`${applied.applied} revision${applied.applied === 1 ? "" : "s"} saved${applied.arrears ? `, ${applied.arrears} with arrears` : ""}`}>
          {applied.failed.length > 0 && <ul className="mt-1 list-disc pl-5">{applied.failed.map((f, i) => <li key={i}>{f.name}: {f.error}</li>)}</ul>}
        </Banner>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {d.isAdmin ? <>
          <StatTile label="Budget" value={c.budgetPaise == null ? "No limit" : inr(c.budgetPaise)} />
          <StatTile label="Recommended" value={inr(d.totals.usedPaise)} hint={`${d.totals.pct}% of current pay`} />
          <StatTile label="Left" value={c.budgetPaise == null ? "—" : inr(c.budgetPaise - d.totals.usedPaise)} hint={overAll ? "Over budget" : undefined} />
          <StatTile label="People" value={d.totals.people} />
        </> : null}
        {d.team.people > 0 && <>
          <StatTile label="Your team's share" value={d.team.poolPaise == null ? "No limit" : inr(d.team.poolPaise)} />
          <StatTile label="You've recommended" value={inr(d.team.usedPaise)} hint={over ? "Over your share" : `${d.team.people} people`} />
        </>}
      </div>
      {over && <Banner tone="danger" title="Over your team's budget">Lower some increments before sending: the total is {inr(d.team.usedPaise - (d.team.poolPaise ?? 0))} more than your share.</Banner>}
      {overAll && d.isAdmin && <Banner tone="warning" title="Over the cycle budget">Recommendations add up to more than the budget.</Banner>}
      {d.isAdmin && <MatrixCard d={d} />}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2"><h3 className="flex-1 text-md font-semibold">{d.isAdmin ? "Everyone" : "Your team"}</h3>
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-44"><Select size="sm" value={filter} onValueChange={setFilter} options={[{ value: "all", label: "All" }, ...(Object.keys(STATUS) as Row["status"][]).map((s) => ({ value: s, label: STATUS[s].label }))]} /></div>
            {c.status === "recommending" && mineToSend.length > 0 && <ConfirmDialog trigger={<Button size="sm" disabled={over}><Send />Send {mineToSend.length} for approval</Button>} tone="primary" confirmLabel="Send"
              title="Send your recommendations?" description="Each goes to your manager and then to HR for approval. You can withdraw one until someone approves it." onConfirm={() => run(() => submitRecommendationsAction(c.id), "Sent for approval")} />}
          </div></div>
          <DataTable caption="Increment proposals" rows={rows} columns={cols} rowKey={(r) => r.id} empty={<EmptyState icon={<Users />} title={c.status === "draft" ? "Open the cycle to create proposals" : "No proposals here"} />} />
      </div>
      {editing && <Recommend r={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function MatrixCard({ d }: { d: D }) {
  const c = d.cycle;
  const editable = c.status === "draft" || c.status === "recommending";
  const [m, setM] = React.useState(fromMatrix(c.matrix));
  const [budget, setBudget] = React.useState(c.budgetPaise == null ? "" : String(c.budgetPaise / 100));
  const [review, setReview] = React.useState(c.reviewCycleId ?? "none");
  const [eff, setEff] = React.useState(c.effectiveFrom);
  const [busy, setBusy] = React.useState(false);
  return (
    <Card>
      <CardHeader title="Guide and budget" description={editable ? "Changes apply to recommendations made from now on." : undefined} />
      <CardBody className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Budget (₹ a year)"><Input inputMode="decimal" value={budget} disabled={!editable} onChange={(e) => setBudget(e.target.value)} placeholder="No limit" /></Field>
          <Field label="Ratings from"><Select value={review} disabled={c.status !== "draft"} onValueChange={setReview} options={[{ value: "none", label: "No review cycle" }, ...d.reviewCycles.map((r) => ({ value: r.id, label: r.name }))]} /></Field>
          <Field label="New pay starts"><Input type="date" value={eff} disabled={c.status !== "draft"} onChange={(e) => setEff(e.target.value)} /></Field>
        </div>
        <MatrixEditor rows={m} onChange={setM} disabled={!editable} />
        {editable && <Button className="self-end" size="sm" loading={busy} onClick={async () => {
          const b = budget.trim() === "" ? null : Math.round(Number(budget.replace(/[,₹\s]/g, "")) * 100);
          if (b != null && !Number.isFinite(b)) { toast.error("Enter the budget in rupees."); return; }
          setBusy(true);
          const r = await updateCompCycleAction(c.id, { name: c.name, reviewCycleId: review === "none" ? null : review, effectiveFrom: eff, budgetPaise: b, matrix: toMatrix(m) });
          setBusy(false);
          if (r.ok) toast.success("Saved"); else toast.error(r.error);
        }}>Save guide</Button>}
      </CardBody>
    </Card>
  );
}

function Recommend({ r, onClose }: { r: Row; onClose: () => void }) {
  const [pct, setPct] = React.useState(String(r.increment_bp / 100));
  const [note, setNote] = React.useState(r.note ?? "");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const bp = Math.round(Number(pct) * 100);
  const preview = Number.isFinite(bp) ? Math.round((r.current * (10_000 + bp)) / 10_000 / 100) * 100 : r.current;
  const outside = r.range && (Number(pct) < r.range[0] || Number(pct) > r.range[1]);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="sm" title={`Increment for ${r.name}`} description={`Rating ${r.rating ?? "not available"} · current ${inr(r.current)} a year`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={async () => {
        setBusy(true); setErr(null);
        const res = await recommendAction(r.id, { incrementBp: bp, note: note || null });
        setBusy(false);
        if (res.ok) { toast.success("Saved"); onClose(); } else setErr(res.error);
      }}>Save</Button></>}>
      <div className="flex flex-col gap-4">
        {err && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{err}</p>}
        <Field label="Increment (%)" help={r.range ? `The guide for this rating is ${r.range[0]}% to ${r.range[1]}%` : "No rating, so any raise up to the guide's highest is allowed"}>
          <Input type="number" inputMode="decimal" step="0.25" min={0} max={100} value={pct} onChange={(e) => setPct(e.target.value)} aria-invalid={outside || undefined} />
        </Field>
        <p className="text-base">New CTC: <span className="font-semibold tabular">{inr(preview)}</span> <span className="text-text-muted">(+{inr(preview - r.current)})</span></p>
        {outside && <p className="flex items-center gap-1.5 text-sm text-danger-text"><AlertTriangle className="size-4" aria-hidden />Outside the guide for this rating.</p>}
        <Field label="Note for approvers"><Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={1000} /></Field>
      </div>
    </Modal>
  );
}
