"use client";
import * as React from "react";
import { Search, Users } from "lucide-react";
import { Button } from "@/ui/button";
import { RadioGroup } from "@/ui/choice";
import { Field, Input } from "@/ui/field";
import { Banner, EmptyState } from "@/ui/feedback";
import { Modal } from "@/ui/overlay";
import { DataTable, type Column } from "@/ui/table";
import { toast } from "@/ui/toast";
import { assignAction } from "@/app/(app)/settings/time/actions";
import type { AssignmentRow } from "@/server/modules/attendance/policies";

type Kind = "shift" | "weekly_off" | "capture" | "penalty";
type Opt = { id: string; name: string; hint?: string };
const TITLE: Record<Kind, string> = { shift: "Change shift", weekly_off: "Change weekly off", capture: "Change clock-in rules", penalty: "Change penalty policy" };
const fmt = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

export function AssignmentsSettings({ rows, options, today }: { rows: AssignmentRow[]; options: Record<Kind, Opt[]>; today: string }) {
  const [q, setQ] = React.useState("");
  const [dialog, setDialog] = React.useState<{ kind: Kind; ids: string[]; clear: () => void } | null>(null);
  const term = q.trim().toLowerCase();
  const shown = term ? rows.filter((r) => [r.name, r.number, r.department ?? "", r.shift ?? "", r.weekly_off ?? ""].some((x) => x.toLowerCase().includes(term))) : rows;
  const cols: Column<AssignmentRow>[] = [
    { key: "name", header: "Person", sortValue: (r) => r.name, cell: (r) => <span className="block min-w-0"><span className="block truncate font-medium">{r.name}</span><span className="block truncate text-sm text-text-muted">{[r.number, r.department].filter(Boolean).join(" · ")}</span></span> },
    { key: "shift", header: "Shift", sortValue: (r) => r.shift ?? "", cell: (r) => <span>{r.shift ?? "Default"}{r.next_shift && <span className="block text-sm text-text-muted">{r.next_shift} from {fmt(r.next_shift_from!)}</span>}</span> },
    { key: "wo", header: "Weekly off", hideBelow: "md", cell: (r) => <span>{r.weekly_off ?? "Default"}{r.next_weekly_off && <span className="block text-sm text-text-muted">{r.next_weekly_off} from {fmt(r.next_weekly_off_from!)}</span>}</span> },
    { key: "cap", header: "Clock-in rules", hideBelow: "lg", cell: (r) => r.capture ?? "Default" },
    { key: "pen", header: "Penalties", hideBelow: "lg", cell: (r) => r.penalty ?? <span className="text-text-muted">None</span> },
  ];
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Assignments</h2>
        <p className="text-base text-text-muted">Pick people, then change their shift, weekly off, clock-in rules or penalty policy. Shift and weekly-off changes take an effective date.</p>
      </div>
      <Input leading={<Search />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, number, department or shift" aria-label="Search people" className="max-w-md" />
      <DataTable caption="Time assignments by person" rows={shown} columns={cols} rowKey={(r) => r.id} selectable
        empty={<EmptyState compact icon={<Users />} title={term ? "Nobody matches that search" : "Nobody to assign yet"} description={term ? "Try a different name or clear the search." : "People you can manage show up here."} />}
        bulkActions={(ids, clear) => (
          <div className="flex flex-wrap justify-end gap-2">
            {(["shift", "weekly_off", "capture", "penalty"] as Kind[]).map((k) => (
              <Button key={k} size="sm" variant="secondary" onClick={() => setDialog({ kind: k, ids, clear })}>{TITLE[k].replace("Change ", "")}</Button>
            ))}
          </div>
        )} />
      {dialog && <AssignDialog kind={dialog.kind} ids={dialog.ids} options={options[dialog.kind]} today={today} onClose={(done) => { if (done) dialog.clear(); setDialog(null); }} />}
    </div>
  );
}

function AssignDialog({ kind, ids, options, today, onClose }: { kind: Kind; ids: string[]; options: Opt[]; today: string; onClose: (done: boolean) => void }) {
  const dated = kind === "shift" || kind === "weekly_off";
  const opts = kind === "penalty" ? [{ id: "none", name: "No penalties" }, ...options] : options;
  const [choice, setChoice] = React.useState(opts[0]?.id ?? "");
  const [from, setFrom] = React.useState(today);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    setError(null);
    const r = await assignAction({ employeeIds: ids, kind, policyId: choice === "none" ? null : choice, from });
    if (!r.ok) { setError(r.error); return; }
    toast.success(`Updated ${ids.length} ${ids.length === 1 ? "person" : "people"}`);
    onClose(true);
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose(false)} title={TITLE[kind]} description={`For ${ids.length} ${ids.length === 1 ? "person" : "people"}.`}
      footer={<><Button variant="secondary" onClick={() => onClose(false)}>Cancel</Button><Button loading={pending} onClick={save} disabled={!choice}>Apply</Button></>}>
      <div className="flex flex-col gap-4">
        {error && <Banner tone="danger">{error}</Banner>}
        {opts.length === 0 ? <Banner tone="warning">Nothing to choose from yet. Add one first.</Banner> : (
          <RadioGroup value={choice} onValueChange={setChoice} options={opts.map((o) => ({ value: o.id, label: o.name, hint: o.hint }))} aria-label={TITLE[kind]} />
        )}
        {dated ? (
          <Field label="Effective from" required help="Their current one ends the day before. Plans after this date are replaced. Past days are recalculated.">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
        ) : <p className="text-sm text-text-muted">This applies straight away.</p>}
      </div>
    </Modal>
  );
}
