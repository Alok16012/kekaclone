"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowRight, ListChecks, Play, Search, UserPlus } from "lucide-react";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { Modal } from "@/ui/overlay";
import { Banner, EmptyState, Progress } from "@/ui/feedback";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { toast } from "@/ui/toast";
import { initiateOnboardingAction } from "@/app/(app)/org/onboarding/actions";
import type { JoinerRow } from "@/server/modules/onboarding/service";

const fmt = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
function joinLabel(d: string, today: string) {
  const n = daysBetween(today, d);
  return n === 0 ? "Joins today" : n > 0 ? `Joins in ${n} ${n === 1 ? "day" : "days"} · ${fmt(d)}` : `Joined ${fmt(d)}`;
}

/** New joiners: who still needs onboarding started, whose is running (with progress and overdue tasks), and who finished. */
export function Joiners({ rows, templates, today, canEditTemplates }: { rows: JoinerRow[]; templates: { id: string; name: string }[]; today: string; canEditTemplates: boolean }) {
  const [q, setQ] = React.useState("");
  const [starting, setStarting] = React.useState<JoinerRow | null>(null);
  const match = (r: JoinerRow) => `${r.name} ${r.number} ${r.department ?? ""} ${r.designation ?? ""}`.toLowerCase().includes(q.trim().toLowerCase());
  const groups = {
    todo: rows.filter((r) => r.process_status !== "in_progress" && r.process_status !== "completed"),
    progress: rows.filter((r) => r.process_status === "in_progress"),
    done: rows.filter((r) => r.process_status === "completed"),
  };
  const list = (items: JoinerRow[], empty: React.ReactNode) => {
    const shown = items.filter(match);
    if (!shown.length) return <Card>{q ? <EmptyState compact icon={<Search />} title="No one matches your search" /> : empty}</Card>;
    return (
      <Card>
        <ul className="divide-y divide-border">
          {shown.map((r) => <JoinerItem key={r.id} r={r} today={today} onStart={() => setStarting(r)} />)}
        </ul>
      </Card>
    );
  };
  return (
    <>
      <Tabs defaultValue={groups.todo.length || !groups.progress.length ? "todo" : "progress"}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <TabsList items={[{ value: "todo", label: "To start", count: groups.todo.length }, { value: "progress", label: "In progress", count: groups.progress.length }, { value: "done", label: "Completed", count: groups.done.length }]} />
          <div className="sm:w-64"><Input inputSize="sm" leading={<Search />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search joiners" aria-label="Search joiners" /></div>
        </div>
        <TabsContent value="todo">{list(groups.todo, <EmptyState icon={<UserPlus />} title="Everyone's onboarding has started" description="People you add with a joining date, and new hires from Hiring, show up here." />)}</TabsContent>
        <TabsContent value="progress">{list(groups.progress, <EmptyState icon={<ListChecks />} title="No onboarding in progress" description="Start onboarding for a new joiner to create their checklist." />)}</TabsContent>
        <TabsContent value="done">{list(groups.done, <EmptyState icon={<ListChecks />} title="Nothing finished yet" description="Onboarding moves here once every task is done or skipped." />)}</TabsContent>
      </Tabs>
      {starting && <StartDialog r={starting} templates={templates} canEditTemplates={canEditTemplates} onClose={() => setStarting(null)} />}
    </>
  );
}

function JoinerItem({ r, today, onStart }: { r: JoinerRow; today: string; onStart: () => void }) {
  const running = r.process_status === "in_progress" || r.process_status === "completed";
  return (
    <li className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar name={r.name} size="sm" />
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-base font-medium">
            <span className="truncate">{r.name}</span>
            {r.status === "preboarding" && <Badge tone="accent">Preboarding</Badge>}
            {r.overdue > 0 && <Badge tone="danger">{r.overdue} overdue</Badge>}
          </p>
          <p className="truncate text-sm text-text-muted">{[r.designation, r.department, r.location].filter(Boolean).join(" · ") || r.number}</p>
          <p className="text-sm text-text-muted">{joinLabel(r.joining_date, today)}</p>
        </div>
      </div>
      {running ? (
        <div className="flex items-center gap-3 sm:w-80">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex justify-between text-sm text-text-muted"><span className="truncate">{r.template ?? "Checklist"}</span><span className="tabular">{r.done}/{r.total}</span></div>
            <Progress value={r.done} max={Math.max(1, r.total)} label={`${r.name}: ${r.done} of ${r.total} tasks done`} tone={r.overdue ? "warning" : r.process_status === "completed" ? "success" : "accent"} />
          </div>
          <Button asChild size="sm" variant="secondary"><Link href={`/org/onboarding/${r.process_id}`} aria-label={`Open ${r.name}'s onboarding`}>Open<ArrowRight /></Link></Button>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          {r.suggested && <span className="hidden text-sm text-text-muted md:inline">Template: {r.suggested}</span>}
          <Button size="sm" onClick={onStart}><Play />Start onboarding</Button>
        </div>
      )}
    </li>
  );
}

function StartDialog({ r, templates, canEditTemplates, onClose }: { r: JoinerRow; templates: { id: string; name: string }[]; canEditTemplates: boolean; onClose: () => void }) {
  const [tpl, setTpl] = React.useState<string>("auto");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const go = () => start(async () => {
    const res = await initiateOnboardingAction(r.id, tpl === "auto" ? null : tpl);
    if (!res.ok) { setError(res.error); return; }
    toast.success(`Onboarding started for ${r.name.split(" ")[0]}`, { description: `${res.data?.tasks ?? 0} tasks created and their owners told.` });
    onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="sm" title={`Start onboarding for ${r.name}`} description="Tasks are created with owners and due dates counted from the joining date."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={go} disabled={!templates.length}><Play />Start</Button></>}>
      {error && <Banner tone="danger" className="mb-4">{error}</Banner>}
      <Field label="Checklist" help={tpl === "auto" ? (r.suggested ? `Matches “${r.suggested}” for their department, location and designation.` : "No template matches; pick one.") : undefined}>
        <Select value={tpl} onValueChange={setTpl} options={[{ value: "auto", label: r.suggested ? `Best match (${r.suggested})` : "Best match" }, ...templates.map((t) => ({ value: t.id, label: t.name }))]} />
      </Field>
      {canEditTemplates && <p className="mt-3 text-sm text-text-muted">Edit checklists in <Link className="text-accent-text hover:underline" href="/settings/tasks">Settings → Onboarding tasks</Link>.</p>}
    </Modal>
  );
}
