"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IndianRupee, Plus, Trash2 } from "lucide-react";
import { COMP_STATUS_LABEL, type CompStatus, type MatrixRow } from "@/server/modules/performance/rules";
import { Card } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Modal } from "@/ui/overlay";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { createCompCycleAction } from "@/app/(app)/compensation/actions";
import { fmtDate, inr } from "./bits";

type Row = { id: string; name: string; effective_from: string; budget_paise: number | null; status: CompStatus; people: number; used: number; mine: number; review_cycle: string | null };
export const TONE: Record<CompStatus, "neutral" | "accent" | "warning" | "success"> = { draft: "neutral", recommending: "accent", approving: "warning", approved: "success", applied: "success" };

export function CompList({ admin, cycles, reviewCycles, today }: { admin: boolean; cycles: Row[]; reviewCycles: { id: string; name: string; status: string }[]; today: string }) {
  const [creating, setCreating] = React.useState(false);
  return (
    <>
      {admin && <div className="mb-4 flex justify-end"><Button onClick={() => setCreating(true)}><Plus />New increment cycle</Button></div>}
      {!cycles.length ? <Card><EmptyState icon={<IndianRupee />} title={admin ? "No increment cycles yet" : "Nothing to recommend"} description={admin ? "Set a budget and a rating-to-increment guide, then managers recommend raises for their teams." : "When HR opens an increment cycle, your team shows up here."} /></Card> : (
        <Card>
          <ul className="divide-y divide-border">{cycles.map((c) => (
            <li key={c.id}>
              <Link href={`/compensation/${c.id}`} className="flex flex-col gap-1 px-5 py-3.5 hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none sm:flex-row sm:items-center sm:gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-base font-medium">{c.name}</p>
                  <p className="text-sm text-text-muted">From {fmtDate(c.effective_from)}{c.review_cycle ? ` · ratings from ${c.review_cycle}` : ""}{admin ? ` · ${c.people} people` : ` · ${c.mine} in your team`}</p>
                </div>
                {admin && c.budget_paise != null && <span className="text-sm tabular text-text-muted">{inr(c.used)} of {inr(c.budget_paise)}</span>}
                <Badge tone={TONE[c.status]}>{COMP_STATUS_LABEL[c.status]}</Badge>
              </Link>
            </li>
          ))}</ul>
        </Card>
      )}
      {creating && <NewCycle reviewCycles={reviewCycles} today={today} onClose={() => setCreating(false)} />}
    </>
  );
}

export type MatrixDraft = { rating_min: string; rating_max: string; increment_pct_min: string; increment_pct_max: string; increment_pct_default: string };
export const DEFAULT_MATRIX: MatrixDraft[] = [
  { rating_min: "1", rating_max: "1.99", increment_pct_min: "0", increment_pct_max: "3", increment_pct_default: "0" },
  { rating_min: "2", rating_max: "2.99", increment_pct_min: "3", increment_pct_max: "6", increment_pct_default: "4" },
  { rating_min: "3", rating_max: "3.74", increment_pct_min: "6", increment_pct_max: "10", increment_pct_default: "8" },
  { rating_min: "3.75", rating_max: "4.49", increment_pct_min: "10", increment_pct_max: "15", increment_pct_default: "12" },
  { rating_min: "4.5", rating_max: "5", increment_pct_min: "15", increment_pct_max: "25", increment_pct_default: "18" },
];
export const toMatrix = (m: MatrixDraft[]): MatrixRow[] => m.map((r) => ({ rating_min: Number(r.rating_min), rating_max: Number(r.rating_max), increment_pct_min: Number(r.increment_pct_min), increment_pct_max: Number(r.increment_pct_max), increment_pct_default: r.increment_pct_default === "" ? undefined : Number(r.increment_pct_default) }));
export const fromMatrix = (m: MatrixRow[]): MatrixDraft[] => m.map((r) => ({ rating_min: String(r.rating_min), rating_max: String(r.rating_max), increment_pct_min: String(r.increment_pct_min), increment_pct_max: String(r.increment_pct_max), increment_pct_default: r.increment_pct_default == null ? "" : String(r.increment_pct_default) }));

/** Rating → increment guide: one row per rating range with the lowest, suggested and highest raise. */
export function MatrixEditor({ rows, onChange, disabled }: { rows: MatrixDraft[]; onChange: (r: MatrixDraft[]) => void; disabled?: boolean }) {
  const set = (i: number, k: keyof MatrixDraft, v: string) => onChange(rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const cols: [keyof MatrixDraft, string][] = [["rating_min", "Rating from"], ["rating_max", "to"], ["increment_pct_min", "Lowest %"], ["increment_pct_default", "Suggested %"], ["increment_pct_max", "Highest %"]];
  return (
    <div className="flex flex-col gap-2">
      <div className="hidden grid-cols-[repeat(5,1fr)_2.25rem] gap-2 text-xs font-medium text-text-muted sm:grid">{cols.map(([, l]) => <span key={l}>{l}</span>)}<span /></div>
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-5 gap-2 sm:grid-cols-[repeat(5,1fr)_2.25rem]">
          {cols.map(([k, l]) => <Input key={k} aria-label={`Row ${i + 1} ${l}`} type="number" inputMode="decimal" step="0.01" value={r[k]} disabled={disabled} onChange={(e) => set(i, k, e.target.value)} />)}
          {!disabled && <IconButton className="hidden sm:inline-flex" label={`Remove row ${i + 1}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}><Trash2 /></IconButton>}
        </div>
      ))}
      {!disabled && rows.length < 10 && <Button size="sm" variant="secondary" className="self-start" onClick={() => onChange([...rows, { rating_min: "", rating_max: "", increment_pct_min: "", increment_pct_max: "", increment_pct_default: "" }])}><Plus />Add row</Button>}
    </div>
  );
}

const rupeesToPaise = (s: string) => { const t = s.replace(/[,₹\s]/g, ""); if (!/^\d+(\.\d{1,2})?$/.test(t)) return null; const [r, p = ""] = t.split("."); return Number(r) * 100 + Number((p + "00").slice(0, 2)); };

function NewCycle({ reviewCycles, today, onClose }: { reviewCycles: { id: string; name: string; status: string }[]; today: string; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = React.useState(`Increments ${Number(today.slice(0, 4)) + 1}`);
  const [review, setReview] = React.useState(reviewCycles.find((r) => r.status === "published" || r.status === "closed")?.id ?? "none");
  const [eff, setEff] = React.useState(`${Number(today.slice(0, 4)) + (today.slice(5, 7) > "03" ? 1 : 0)}-04-01`);
  const [budget, setBudget] = React.useState("");
  const [matrix, setMatrix] = React.useState(DEFAULT_MATRIX);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="lg" title="New increment cycle"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={async () => {
        const b = budget.trim() ? rupeesToPaise(budget) : null;
        if (budget.trim() && b == null) { setErr("Enter the budget in rupees, like 1500000."); return; }
        setBusy(true); setErr(null);
        const r = await createCompCycleAction({ name, reviewCycleId: review === "none" ? null : review, effectiveFrom: eff, budgetPaise: b, matrix: toMatrix(matrix) });
        setBusy(false);
        if (r.ok) { toast.success("Cycle created"); onClose(); router.push(`/compensation/${r.data!.id}`); } else setErr(r.error);
      }}>Create</Button></>}>
      <div className="flex flex-col gap-4">
        {err && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{err}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
          <Field label="Ratings from" help="The review cycle whose final ratings guide the raises"><Select value={review} onValueChange={setReview} options={[{ value: "none", label: "No review cycle" }, ...reviewCycles.map((r) => ({ value: r.id, label: r.name }))]} /></Field>
          <Field label="New pay starts" required help="A date in a month that's already paid creates arrears"><Input type="date" value={eff} onChange={(e) => setEff(e.target.value)} /></Field>
          <Field label="Budget (₹ a year)" help="The total increase in yearly pay. Leave empty for no limit."><Input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="1500000" /></Field>
        </div>
        <fieldset><legend className="mb-2 text-sm font-semibold">Rating → increment guide</legend><MatrixEditor rows={matrix} onChange={setMatrix} /></fieldset>
      </div>
    </Modal>
  );
}
