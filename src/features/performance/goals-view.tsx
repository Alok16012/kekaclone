"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, GitBranch, LineChart, Lock, MoreHorizontal, Paperclip, Plus, Target, Trash2 } from "lucide-react";
import type { Goal } from "@/server/modules/performance/goals";
import { LEVEL_LABEL, type GoalStatus, type Level, type Metric } from "@/server/modules/performance/rules";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { Card } from "@/ui/card";
import { Button } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Modal, Drawer, Menu, ConfirmDialog } from "@/ui/overlay";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { EmptyState, Skeleton } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { checkInAction, closeGoalAction, createGoalAction, deleteGoalAction, goalDetailAction, updateGoalAction } from "@/app/(app)/me/performance/actions";
import { fmtDate, GoalStatusBadge, ProgressLine } from "./bits";

type Period = { id: string; name: string; starts_on: string; ends_on: string };
type Align = { id: string; title: string; level: Level; owner: string | null; department: string | null };
type Person = { id: string; name: string };
type Words = { goal: string; goals: string; kr: string; krs: string };

export function GoalsView(p: {
  periods: Period[]; periodId: string | null; mine: Goal[]; team: Goal[]; department: Goal[]; company: Goal[]; align: Align[]; goalMode: "okr" | "kra"; me: string;
  owners: Person[]; departments: Person[]; canCompany: boolean; hasTeam: boolean; initialTab: string; openNew: boolean; today: string;
}) {
  const router = useRouter();
  const words: Words = p.goalMode === "kra" ? { goal: "KRA", goals: "KRAs", kr: "measure", krs: "Measures" } : { goal: "objective", goals: "Objectives", kr: "key result", krs: "Key results" };
  const [tab, setTab] = React.useState(p.initialTab);
  const [editing, setEditing] = React.useState<Goal | "new" | null>(p.openNew ? "new" : null);
  const [checking, setChecking] = React.useState<Goal | null>(null);
  const lists: Record<string, Goal[]> = { mine: p.mine, team: p.team, department: p.department, company: p.company };
  const weightTotal = p.mine.filter((g) => g.status !== "closed").reduce((s, g) => s + g.weight, 0);
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="w-48">
          <Select size="sm" value={p.periodId ?? undefined} placeholder="All periods" onValueChange={(v) => router.push(`/me/performance?period=${v}&tab=${tab}`)}
            options={p.periods.map((x) => ({ value: x.id, label: x.name }))} />
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" asChild><Link href="/performance/okr-tree"><GitBranch />Alignment tree</Link></Button>
          {p.hasTeam && <Button variant="secondary" size="sm" asChild><Link href="/performance/insights"><LineChart />Team insights</Link></Button>}
          <Button size="sm" onClick={() => setEditing("new")}><Plus />Add {words.goal}</Button>
        </div>
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList items={[
          { value: "mine", label: `My ${words.goals.toLowerCase()}`, count: p.mine.length },
          ...(p.hasTeam ? [{ value: "team", label: "My team", count: p.team.length }] : []),
          { value: "department", label: "Department", count: p.department.length },
          { value: "company", label: "Company", count: p.company.length },
        ]} />
        {Object.entries(lists).map(([k, goals]) => (
          <TabsContent key={k} value={k}>
            {k === "mine" && p.goalMode === "kra" && goals.length > 0 && Math.round(weightTotal) !== 100 && (
              <p role="status" className="mb-3 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning-text">Your KRA weights add up to {Math.round(weightTotal)}%. They should add up to 100%.</p>
            )}
            {goals.length ? (
              <ul className="flex flex-col gap-3">{goals.map((g) => <li key={g.id}><GoalCard g={g} words={words} today={p.today} showOwner={k !== "mine"} onEdit={() => setEditing(g)} onCheckIn={() => setChecking(g)} /></li>)}</ul>
            ) : (
              <Card><EmptyState icon={<Target />} title={k === "mine" ? `No ${words.goals.toLowerCase()} yet` : k === "team" ? "Your team has no goals in this period" : `No ${k} goals in this period`}
                description={k === "mine" ? "Set a goal, add measurable results, and check in as you go." : undefined}
                action={k === "mine" ? <Button size="sm" onClick={() => setEditing("new")}><Plus />Add {words.goal}</Button> : undefined} /></Card>
            )}
          </TabsContent>
        ))}
      </Tabs>
      {editing && <GoalEditor goal={editing === "new" ? null : editing} words={words} {...p} defaultLevel={tab === "company" && p.canCompany ? "company" : tab === "department" && p.departments.length ? "department" : "individual"} onClose={() => setEditing(null)} />}
      {checking && <CheckInDrawer goal={checking} words={words} onClose={() => setChecking(null)} />}
    </>
  );
}

function GoalCard({ g, words, today, showOwner, onEdit, onCheckIn }: { g: Goal; words: Words; today: string; showOwner: boolean; onEdit: () => void; onCheckIn: () => void }) {
  const [open, setOpen] = React.useState(false);
  const overdue = g.due_date && g.status !== "completed" && g.status !== "closed" && g.progress < 100 && g.due_date < today;
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={open ? "Hide details" : "Show details"} className="mt-0.5 rounded-sm text-text-muted hover:text-text">
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold">{g.title}</h3>
            {g.visibility === "private" && <Badge><Lock aria-hidden />Private</Badge>}
            <Badge tone="neutral">{LEVEL_LABEL[g.level]}{g.level === "department" && g.department ? ` · ${g.department}` : ""}</Badge>
          </div>
          <p className="mt-0.5 text-sm text-text-muted">
            {showOwner && g.owner ? `${g.owner} · ` : ""}{g.due_date ? <span className={overdue ? "font-medium text-danger-text" : undefined}>Due {fmtDate(g.due_date)}{overdue ? " (overdue)" : ""}</span> : "No due date"}
            {g.weight ? ` · weight ${g.weight}%` : ""}{g.parent_title ? ` · aligned to “${g.parent_title}”` : ""}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-3">
            <div className="min-w-40 flex-1"><ProgressLine value={g.progress} label={`${g.title} progress`} /></div>
            <GoalStatusBadge status={g.status} />
          </div>
        </div>
        {g.can_edit && (
          <div className="flex shrink-0 items-center gap-1">
            {g.status !== "closed" && <Button size="sm" variant="secondary" onClick={onCheckIn}>Check in</Button>}
            <GoalMenu g={g} onEdit={onEdit} />
          </div>
        )}
      </div>
      {g.key_results.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2 border-t border-border pt-3 pl-7" aria-label={words.krs}>
          {g.key_results.map((k) => (
            <li key={k.id} className="grid grid-cols-1 gap-1 sm:grid-cols-[1fr_12rem] sm:items-center sm:gap-4">
              <span className="text-sm">{k.title} <span className="text-text-muted tabular">· {fmtKr(k.metric, k.current)} of {fmtKr(k.metric, k.target)}{k.weight ? ` · ${k.weight}%` : ""}</span></span>
              <ProgressLine value={k.progress} label={`${k.title} progress`} />
            </li>
          ))}
        </ul>
      )}
      {open && <GoalDetail id={g.id} description={g.description} />}
    </Card>
  );
}

const fmtKr = (m: Metric, v: number) => (m === "boolean" ? (v >= 1 ? "done" : "not done") : m === "percent" ? `${v}%` : m === "currency" ? `₹${v.toLocaleString("en-IN")}` : v.toLocaleString("en-IN"));

function GoalMenu({ g, onEdit }: { g: Goal; onEdit: () => void }) {
  const [confirm, setConfirm] = React.useState(false);
  return (
    <>
      <Menu trigger={<Button variant="ghost" size="icon-sm" aria-label={`More actions for ${g.title}`}><MoreHorizontal /></Button>} items={[
        { label: "Edit", onSelect: onEdit },
        { label: g.status === "closed" ? "Reopen" : "Close", onSelect: async () => { const r = await closeGoalAction(g.id, g.status !== "closed"); if (r.ok) toast.success(g.status === "closed" ? "Reopened" : "Closed"); else toast.error(r.error); } },
        { label: "Delete", onSelect: () => setConfirm(true), danger: true },
      ]} />
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title="Delete this goal?" description="Its key results and check-ins are deleted too. Goals aligned to it stay, unaligned." confirmLabel="Delete"
        onConfirm={async () => { const r = await deleteGoalAction(g.id); if (r.ok) toast.success("Deleted"); else toast.error(r.error); }} />
    </>
  );
}

type Detail = { checkIns: { id: string; author: string; created_at: string; status: string | null; progress: number | null; comment: string | null; value: number | null; kr: string | null; files: { id: string; name: string }[] }[]; aligned: { id: string; title: string; owner: string | null; progress: number; status: GoalStatus }[] };
function GoalDetail({ id, description }: { id: string; description: string | null }) {
  const [d, setD] = React.useState<{ id: string; v?: Detail; error?: string } | null>(null);
  React.useEffect(() => {
    let live = true;
    goalDetailAction(id).then((r) => { if (live) setD(r.ok ? { id, v: r.data } : { id, error: r.error }); });
    return () => { live = false; };
  }, [id]);
  const s = d?.id === id ? d : null;
  return (
    <div className="mt-3 border-t border-border pt-3 pl-7">
      {description && <p className="mb-3 whitespace-pre-line text-sm">{description}</p>}
      {!s ? <div aria-busy className="flex flex-col gap-2"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-4 w-2/3" /></div> : s.error ? <p className="text-sm text-danger-text">{s.error}</p> : (
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <h4 className="mb-2 text-sm font-semibold">Check-ins</h4>
            {s.v!.checkIns.filter((c) => !c.kr).length === 0 ? <p className="text-sm text-text-muted">No check-ins yet.</p> : (
              <ol className="flex flex-col gap-2.5">
                {s.v!.checkIns.filter((c) => !c.kr).map((c) => (
                  <li key={c.id} className="rounded-md bg-surface-sunken px-3 py-2 text-sm">
                    <p className="flex flex-wrap items-center gap-2"><span className="font-medium">{c.author}</span><span className="text-text-muted">{fmtDate(c.created_at)}</span>
                      {c.status && <GoalStatusBadge status={c.status as GoalStatus} />}{c.progress != null && <span className="tabular text-text-muted">{Math.round(c.progress)}%</span>}</p>
                    {c.comment && <p className="mt-1 whitespace-pre-line">{c.comment}</p>}
                    {c.files.length > 0 && <p className="mt-1 flex flex-wrap gap-2">{c.files.map((f) => <a key={f.id} href={`/me/performance/files/${f.id}`} className="inline-flex items-center gap-1 text-accent-text hover:underline" target="_blank" rel="noreferrer"><Paperclip className="size-3.5" aria-hidden />{f.name}</a>)}</p>}
                  </li>
                ))}
              </ol>
            )}
          </div>
          <div>
            <h4 className="mb-2 text-sm font-semibold">Aligned to this</h4>
            {s.v!.aligned.length === 0 ? <p className="text-sm text-text-muted">Nothing is aligned to this goal yet.</p> : (
              <ul className="flex flex-col gap-2">{s.v!.aligned.map((a) => (
                <li key={a.id} className="text-sm"><p>{a.title} <span className="text-text-muted">{a.owner ? `· ${a.owner}` : ""}</span></p><ProgressLine value={a.progress} label={`${a.title} progress`} /></li>
              ))}</ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

type KrDraft = { id?: string; title: string; metric: Metric; start: string; target: string; weight: string };
function GoalEditor({ goal, words, onClose, align, owners, departments, canCompany, periods, periodId, me, defaultLevel }: {
  goal: Goal | null; words: Words; onClose: () => void; align: Align[]; owners: Person[]; departments: Person[]; canCompany: boolean; periods: Period[]; periodId: string | null; me: string; defaultLevel: Level;
}) {
  const [level, setLevel] = React.useState<Level>(goal?.level ?? defaultLevel);
  const [ownerId, setOwnerId] = React.useState(goal?.owner_id ?? me);
  const [departmentId, setDepartmentId] = React.useState(goal?.department_id ?? departments[0]?.id ?? "");
  const [period, setPeriod] = React.useState(goal?.period_id ?? periodId ?? "");
  const [parentId, setParentId] = React.useState(goal?.parent_id ?? "");
  const [title, setTitle] = React.useState(goal?.title ?? "");
  const [description, setDescription] = React.useState(goal?.description ?? "");
  const [dueDate, setDueDate] = React.useState(goal?.due_date ?? "");
  const [weight, setWeight] = React.useState(String(goal?.weight ?? 0));
  const [visibility, setVisibility] = React.useState(goal?.visibility ?? "public");
  const [krs, setKrs] = React.useState<KrDraft[]>(goal?.key_results.map((k) => ({ id: k.id, title: k.title, metric: k.metric, start: String(k.start), target: String(k.target), weight: String(k.weight) })) ?? []);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<{ msg: string; field?: string } | null>(null);
  const levels: Level[] = ["individual", ...(departments.length ? ["department" as const] : []), ...(canCompany ? ["company" as const] : [])];
  const parents = align.filter((a) => a.id !== goal?.id && (level === "company" ? a.level === "company" : level === "department" ? a.level !== "individual" : true));
  const save = async () => {
    setBusy(true); setErr(null);
    const payload = {
      level, ownerId: level === "individual" ? ownerId : null, departmentId: level === "department" ? departmentId : null, periodId: period || null, parentId: parentId || null,
      title, description: description || null, dueDate: dueDate || null, weight: Number(weight) || 0, visibility,
      keyResults: krs.map((k) => ({ id: k.id, title: k.title, metric: k.metric, start: Number(k.start) || 0, target: k.metric === "boolean" ? 1 : Number(k.target), weight: Number(k.weight) || 0 })),
    };
    if (payload.keyResults.some((k) => !Number.isFinite(k.target))) { setBusy(false); setErr({ msg: `Every ${words.kr} needs a target number.`, field: "keyResults" }); return; }
    const r = goal ? await updateGoalAction(goal.id, payload) : await createGoalAction(payload);
    setBusy(false);
    if (r.ok) { toast.success(goal ? "Saved" : "Goal added"); onClose(); } else setErr({ msg: r.error, field: r.field });
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="lg" title={goal ? `Edit ${words.goal}` : `Add ${words.goal}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={save}>{goal ? "Save" : "Add"}</Button></>}>
      <div className="flex flex-col gap-4">
        {err && !err.field && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{err.msg}</p>}
        <div className="grid gap-4 sm:grid-cols-2">
          {!goal && levels.length > 1 && <Field label="Level"><Select value={level} onValueChange={(v) => { setLevel(v as Level); setParentId(""); }} options={levels.map((l) => ({ value: l, label: LEVEL_LABEL[l] }))} /></Field>}
          {!goal && level === "individual" && owners.length > 1 && <Field label="Whose goal" error={err?.field === "ownerId" ? err.msg : undefined}><Select value={ownerId} onValueChange={setOwnerId} options={owners.map((o) => ({ value: o.id, label: o.id === me ? `Me (${o.name})` : o.name }))} /></Field>}
          {!goal && level === "department" && <Field label="Department" error={err?.field === "departmentId" ? err.msg : undefined}><Select value={departmentId} onValueChange={setDepartmentId} options={departments.map((d) => ({ value: d.id, label: d.name }))} /></Field>}
          <Field label="Period"><Select value={period || undefined} placeholder="No period" onValueChange={setPeriod} options={periods.map((x) => ({ value: x.id, label: x.name }))} /></Field>
        </div>
        <Field label="Title" required error={err?.field === "title" ? err.msg : undefined}><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="What do you want to achieve?" /></Field>
        <Field label="Description" help="Optional: why it matters, how you'll go about it"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} rows={3} /></Field>
        <Field label="Aligns to" help="Link it to a goal above it so progress rolls up" error={err?.field === "parentId" ? err.msg : undefined}>
          <Select value={parentId || "none"} onValueChange={(v) => setParentId(v === "none" ? "" : v)}
            options={[{ value: "none", label: "Not aligned" }, ...parents.map((a) => ({ value: a.id, label: `${LEVEL_LABEL[a.level]}: ${a.title}${a.owner ? ` (${a.owner})` : a.department ? ` (${a.department})` : ""}` }))]} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Due date"><Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
          <Field label="Weight (%)" help="Share in the parent's roll-up"><Input type="number" inputMode="decimal" min={0} max={100} value={weight} onChange={(e) => setWeight(e.target.value)} /></Field>
          <Field label="Who can see it"><Select value={visibility} onValueChange={(v) => setVisibility(v as "public" | "private")} options={[{ value: "public", label: "Everyone" }, { value: "private", label: "Me and my managers" }]} /></Field>
        </div>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-semibold">{words.krs}</legend>
          {err?.field === "keyResults" && <p role="alert" className="text-sm text-danger-text">{err.msg}</p>}
          {krs.map((k, i) => (
            <div key={i} className="grid grid-cols-2 gap-2 rounded-md border border-border p-3 sm:grid-cols-[2fr_1fr_1fr_1fr_0.7fr_auto] sm:items-end">
              <Field label="Title" className="col-span-2 sm:col-span-1"><Input value={k.title} onChange={(e) => setKrs(krs.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} maxLength={200} /></Field>
              <Field label="Measured as"><Select value={k.metric} onValueChange={(v) => setKrs(krs.map((x, j) => (j === i ? { ...x, metric: v as Metric } : x)))}
                options={[{ value: "number", label: "Number" }, { value: "percent", label: "Percent" }, { value: "currency", label: "Rupees" }, { value: "boolean", label: "Done / not done" }]} /></Field>
              {k.metric !== "boolean" ? (<>
                <Field label="Start"><Input type="number" inputMode="decimal" value={k.start} onChange={(e) => setKrs(krs.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} /></Field>
                <Field label="Target"><Input type="number" inputMode="decimal" value={k.target} onChange={(e) => setKrs(krs.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)))} /></Field>
              </>) : <div className="hidden sm:col-span-2 sm:block" />}
              <Field label="Weight %"><Input type="number" inputMode="decimal" min={0} max={100} value={k.weight} onChange={(e) => setKrs(krs.map((x, j) => (j === i ? { ...x, weight: e.target.value } : x)))} /></Field>
              <Button variant="ghost" size="icon" aria-label={`Remove ${k.title || words.kr}`} onClick={() => setKrs(krs.filter((_, j) => j !== i))}><Trash2 /></Button>
            </div>
          ))}
          {krs.length < 10 && <Button variant="secondary" size="sm" className="self-start" onClick={() => setKrs([...krs, { title: "", metric: "number", start: "0", target: "", weight: "0" }])}><Plus />Add {words.kr}</Button>}
        </fieldset>
      </div>
    </Modal>
  );
}

function CheckInDrawer({ goal, words, onClose }: { goal: Goal; words: Words; onClose: () => void }) {
  const [status, setStatus] = React.useState<string>(goal.status === "not_started" || goal.status === "closed" ? "on_track" : goal.status);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const formRef = React.useRef<HTMLFormElement>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    const fd = new FormData(formRef.current!);
    fd.set("id", goal.id); fd.set("status", status);
    const r = await checkInAction(fd);
    setBusy(false);
    if (r.ok) { toast.success(`Checked in · ${Math.round(r.data!.progress)}%`); onClose(); } else setErr(r.error);
  };
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} title="Check in" description={goal.title}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="checkin-form" loading={busy}>Save check-in</Button></>}>
      <form id="checkin-form" ref={formRef} onSubmit={submit} className="flex flex-col gap-4">
        {err && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{err}</p>}
        {goal.key_results.length ? goal.key_results.map((k) => (
          <Field key={k.id} label={k.title} help={k.metric === "boolean" ? "1 when done, 0 when not" : `Started at ${k.start}, target ${k.target}`}>
            <Input name={`kr:${k.id}`} type="number" inputMode="decimal" step="any" defaultValue={k.current} min={k.metric === "boolean" ? 0 : undefined} max={k.metric === "boolean" ? 1 : undefined} />
          </Field>
        )) : <Field label="Progress (%)" help={`This ${words.goal} has no ${words.krs.toLowerCase()}, so enter the progress directly`}><Input name="progress" type="number" inputMode="decimal" min={0} max={100} defaultValue={Math.round(goal.progress)} /></Field>}
        <Field label="Status"><Select value={status} onValueChange={setStatus} options={[{ value: "on_track", label: "On track" }, { value: "at_risk", label: "At risk" }, { value: "behind", label: "Behind" }, { value: "completed", label: "Completed" }]} /></Field>
        <Field label="Comment" help="What moved, what's in the way"><Textarea name="comment" rows={4} maxLength={2000} /></Field>
        <Field label="Attachments" help="Up to 3 files, 5 MB each (PDF, images, Office files)"><input name="files" type="file" multiple className="text-sm file:mr-3 file:rounded-md file:border file:border-border-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm" /></Field>
      </form>
    </Drawer>
  );
}
