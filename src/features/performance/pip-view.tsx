"use client";
import * as React from "react";
import { ClipboardCheck, Plus, Trash2 } from "lucide-react";
import type { PipSummary } from "@/server/modules/performance/pip";
import { PIP_STATUS_LABEL, type PipStatus } from "@/server/modules/performance/rules";
import { Card } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Modal, Drawer } from "@/ui/overlay";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { EmptyState, Skeleton } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { closePipAction, createPipAction, extendPipAction, pipCheckInAction, pipDetailAction, pipGoalAction } from "@/app/(app)/me/performance/actions";
import { fmtDate } from "./bits";

const TONE: Record<PipStatus, "accent" | "warning" | "success" | "danger" | "neutral"> = { active: "accent", extended: "warning", passed: "success", failed: "danger", cancelled: "neutral" };
const CHECK: Record<string, string> = { on_track: "On track", at_risk: "At risk", off_track: "Off track" };

export function PipView({ pips, eligible, openId, today }: { pips: PipSummary[]; eligible: Person[]; openId: string | null; today: string }) {
  const [open, setOpen] = React.useState<string | null>(openId);
  const [creating, setCreating] = React.useState(false);
  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <p className="flex-1 text-sm text-text-muted">A performance improvement plan sets clear goals and support for a fixed period, with regular check-ins.</p>
        {eligible.length > 0 && <Button size="sm" onClick={() => setCreating(true)}><Plus />Start a plan</Button>}
      </div>
      {!pips.length ? <Card><EmptyState icon={<ClipboardCheck />} title="No plans" description="Plans you're on, or run for your team, show up here." /></Card> : (
        <Card>
          <ul className="divide-y divide-border">
            {pips.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => setOpen(p.id)} className="flex w-full flex-col gap-1 px-5 py-3.5 text-left hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none sm:flex-row sm:items-center sm:gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-base font-medium">{p.mine ? "Your plan" : p.employee}</p>
                    <p className="text-sm text-text-muted">{fmtDate(p.starts_on)} – {fmtDate(p.ends_on)}{p.owner ? ` · run by ${p.owner}` : ""} · {p.goals_met} of {p.goals} goals met</p>
                  </div>
                  <Badge tone={TONE[p.status]}>{PIP_STATUS_LABEL[p.status]}</Badge>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {creating && <CreatePip eligible={eligible} today={today} onClose={() => setCreating(false)} onCreated={setOpen} />}
      {open && <PipDrawer id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function CreatePip({ eligible, today, onClose, onCreated }: { eligible: Person[]; today: string; onClose: () => void; onCreated: (id: string) => void }) {
  const [who, setWho] = React.useState<string[]>([]);
  const [reason, setReason] = React.useState("");
  const [goals, setGoals] = React.useState([{ title: "", measure: "" }]);
  const [startsOn, setStartsOn] = React.useState(today);
  const [endsOn, setEndsOn] = React.useState(() => { const d = new Date(today + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 60); return d.toISOString().slice(0, 10); });
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="lg" title="Start an improvement plan" description="The person is told and can read the plan and add updates."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={async () => {
        setBusy(true); setErr(null);
        const r = await createPipAction({ employeeId: who[0], reason, goals: goals.filter((g) => g.title.trim()).map((g) => ({ title: g.title, measure: g.measure || null })), startsOn, endsOn });
        setBusy(false);
        if (r.ok) { toast.success("Plan started"); onClose(); onCreated(r.data!.id); } else setErr(r.error);
      }}>Start plan</Button></>}>
      <div className="flex flex-col gap-4">
        {err && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{err}</p>}
        <Field label="For" required><EmployeePicker people={eligible} value={who} onChange={setWho} /></Field>
        <Field label="Why the plan is needed" required help="Specific, factual, and kind. They will read this."><Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={4} maxLength={4000} /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Starts"><Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></Field>
          <Field label="Ends"><Input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} /></Field>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-semibold">Goals</legend>
          {goals.map((g, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[2fr_1.5fr_auto]">
              <Input aria-label={`Goal ${i + 1}`} placeholder="What needs to change" value={g.title} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} maxLength={300} />
              <Input aria-label={`How goal ${i + 1} is measured`} placeholder="How it's measured" value={g.measure} onChange={(e) => setGoals(goals.map((x, j) => (j === i ? { ...x, measure: e.target.value } : x)))} maxLength={300} />
              <IconButton label={`Remove goal ${i + 1}`} disabled={goals.length === 1} onClick={() => setGoals(goals.filter((_, j) => j !== i))}><Trash2 /></IconButton>
            </div>
          ))}
          {goals.length < 10 && <Button variant="secondary" size="sm" className="self-start" onClick={() => setGoals([...goals, { title: "", measure: "" }])}><Plus />Add goal</Button>}
        </fieldset>
      </div>
    </Modal>
  );
}

type Detail = { id: string; employee: string; owner: string | null; reason: string; goals: { id: string; title: string; measure: string | null; met: boolean | null }[]; startsOn: string; endsOn: string; status: PipStatus; outcomeNote: string | null; canManage: boolean; isSelf: boolean; checkIns: { id: string; author: string; status: string; note: string; created_at: string }[] };

function PipDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const [d, setD] = React.useState<{ id: string; v?: Detail; error?: string } | null>(null);
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    let live = true;
    pipDetailAction(id).then((r) => { if (live) setD(r.ok ? { id, v: r.data as Detail } : { id, error: r.error }); });
    return () => { live = false; };
  }, [id, tick]);
  const reload = () => setTick((t) => t + 1);
  const s = d?.id === id ? d : null;
  const p = s?.v;
  const open = p && (p.status === "active" || p.status === "extended");
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title={p ? (p.isSelf ? "Your improvement plan" : `Plan for ${p.employee}`) : "Plan"} description={p ? `${fmtDate(p.startsOn)} – ${fmtDate(p.endsOn)} · ${PIP_STATUS_LABEL[p.status]}` : undefined}>
      {!s ? <div aria-busy className="flex flex-col gap-3"><Skeleton className="h-16" /><Skeleton className="h-24" /></div> : s.error ? <p className="text-sm text-danger-text">{s.error}</p> : p && (
        <div className="flex flex-col gap-6">
          <section><h3 className="mb-1 text-sm font-semibold">Why</h3><p className="whitespace-pre-line text-base">{p.reason}</p>{p.owner && <p className="mt-1 text-sm text-text-muted">Run by {p.owner}</p>}</section>
          {p.outcomeNote && <section className="rounded-md bg-surface-sunken p-3"><h3 className="mb-1 text-sm font-semibold">Outcome: {PIP_STATUS_LABEL[p.status]}</h3><p className="whitespace-pre-line text-base">{p.outcomeNote}</p></section>}
          <section>
            <h3 className="mb-2 text-sm font-semibold">Goals</h3>
            <ul className="flex flex-col gap-2">{p.goals.map((g) => (
              <li key={g.id} className="flex flex-col gap-2 rounded-md border border-border px-3 py-2 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1"><p className="text-base">{g.title}</p>{g.measure && <p className="text-sm text-text-muted">{g.measure}</p>}</div>
                {p.canManage && open ? (
                  <div className="w-36"><Select size="sm" value={g.met == null ? "open" : g.met ? "met" : "not"} onValueChange={async (v) => { const r = await pipGoalAction(p.id, g.id, v === "open" ? null : v === "met"); if (r.ok) reload(); else toast.error(r.error); }}
                    options={[{ value: "open", label: "In progress" }, { value: "met", label: "Met" }, { value: "not", label: "Not met" }]} /></div>
                ) : <Badge tone={g.met == null ? "neutral" : g.met ? "success" : "danger"}>{g.met == null ? "In progress" : g.met ? "Met" : "Not met"}</Badge>}
              </li>
            ))}</ul>
          </section>
          {open && <CheckInForm id={p.id} onDone={reload} />}
          <section>
            <h3 className="mb-2 text-sm font-semibold">Check-ins</h3>
            {!p.checkIns.length ? <p className="text-sm text-text-muted">No updates yet.</p> : (
              <ol className="flex flex-col gap-2">{p.checkIns.map((c) => (
                <li key={c.id} className="rounded-md bg-surface-sunken px-3 py-2 text-sm"><p><span className="font-medium">{c.author}</span> <span className="text-text-muted">· {fmtDate(c.created_at)} · {CHECK[c.status]}</span></p><p className="mt-0.5 whitespace-pre-line">{c.note}</p></li>
              ))}</ol>
            )}
          </section>
          {p.canManage && open && <Outcome p={p} onDone={reload} />}
        </div>
      )}
    </Drawer>
  );
}

function CheckInForm({ id, onDone }: { id: string; onDone: () => void }) {
  const [status, setStatus] = React.useState("on_track");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  return (
    <form className="flex flex-col gap-2" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true);
      const r = await pipCheckInAction(id, { status, note });
      setBusy(false);
      if (r.ok) { setNote(""); toast.success("Update added"); onDone(); } else toast.error(r.error);
    }}>
      <h3 className="text-sm font-semibold">Add an update</h3>
      <div className="grid gap-2 sm:grid-cols-[10rem_1fr]">
        <Select value={status} onValueChange={setStatus} options={Object.entries(CHECK).map(([value, label]) => ({ value, label }))} />
        <Textarea aria-label="Update" value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={4000} placeholder="What's happened since the last update" />
      </div>
      <Button type="submit" size="sm" variant="secondary" className="self-end" loading={busy}>Add update</Button>
    </form>
  );
}

function Outcome({ p, onDone }: { p: Detail; onDone: () => void }) {
  const [mode, setMode] = React.useState<"extend" | "close" | null>(null);
  const [outcome, setOutcome] = React.useState<"passed" | "failed" | "cancelled">("passed");
  const [endsOn, setEndsOn] = React.useState(p.endsOn);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  return (
    <section className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
      <Button variant="secondary" onClick={() => setMode("extend")}>Extend</Button>
      <Button onClick={() => setMode("close")}>Close with outcome</Button>
      <Modal open={!!mode} onOpenChange={(o) => !o && setMode(null)} size="sm" title={mode === "extend" ? "Extend the plan" : "Close the plan"}
        footer={<><Button variant="secondary" onClick={() => setMode(null)}>Cancel</Button><Button loading={busy} onClick={async () => {
          setBusy(true);
          const r = mode === "extend" ? await extendPipAction(p.id, endsOn, note) : await closePipAction(p.id, outcome, note);
          setBusy(false);
          if (r.ok) { toast.success(mode === "extend" ? "Extended" : "Closed"); setMode(null); onDone(); } else toast.error(r.error);
        }}>{mode === "extend" ? "Extend" : "Close plan"}</Button></>}>
        <div className="flex flex-col gap-4">
          {mode === "extend" ? <Field label="New end date"><Input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} /></Field>
            : <Field label="Outcome"><Select value={outcome} onValueChange={(v) => setOutcome(v as typeof outcome)} options={[{ value: "passed", label: PIP_STATUS_LABEL.passed }, { value: "failed", label: PIP_STATUS_LABEL.failed }, { value: "cancelled", label: PIP_STATUS_LABEL.cancelled }]} /></Field>}
          <Field label={mode === "extend" ? "Why" : "Outcome note"} required help="The person will read this"><Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={4} maxLength={4000} /></Field>
        </div>
      </Modal>
    </section>
  );
}
