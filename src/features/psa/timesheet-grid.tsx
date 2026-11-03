"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, ChevronLeft, ChevronRight, ClipboardCheck, Lock, Plus, Send, Trash2, Undo2 } from "lucide-react";
import { Card, CardHeader } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Badge, StatusChip } from "@/ui/badge";
import { Checkbox } from "@/ui/choice";
import { Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { Banner, EmptyState } from "@/ui/feedback";
import { ApprovalTimeline } from "@/ui/flow";
import { toast } from "@/ui/toast";
import { saveWeekAction, submitWeekAction, withdrawWeekAction } from "@/app/(app)/me/timesheet/actions";
import { fmtWeek, formatMinutes, parseDuration, TIMESHEET_STATUS_LABEL, type GridRow, type TimesheetStatus } from "@/server/modules/psa/rules";
import type { WeekProject, WeekView } from "@/server/modules/psa/service";
import { addDaysISO } from "@/lib/dates";

type Row = { key: string; projectId: string; taskId: string | null; billable: boolean; note: string; cells: string[] };
const DAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const fmtDay = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const CHIP: Record<TimesheetStatus, "draft" | "pending" | "approved" | "rejected"> = { draft: "draft", submitted: "pending", approved: "approved", rejected: "rejected" };

function toRows(rows: GridRow[]): Row[] {
  return rows.map((r, i) => ({ key: `r${i}-${r.projectId}-${r.taskId ?? ""}`, projectId: r.projectId, taskId: r.taskId, billable: r.billable, note: r.note, cells: r.minutes.map((m) => (m ? formatMinutes(m) : "")) }));
}

/** S127: the weekly grid. Projects × days, hours typed as 8, 8.5 or 8:30; notes and billable per row; save as draft or submit for approval. */
export function TimesheetGrid({ view, today, recent, toApprove }: { view: WeekView; today: string; recent: { week_start: string; status: TimesheetStatus; total_minutes: number }[]; toApprove: number }) {
  const router = useRouter();
  const [rows, setRows] = React.useState<Row[]>(() => toRows(view.rows));
  const [dirty, setDirty] = React.useState(false);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, start] = React.useTransition();
  const editable = view.actions.edit;
  const projectOf = (id: string): WeekProject | undefined => view.projects.find((p) => p.id === id);
  const update = (key: string, patch: Partial<Row>) => { setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r))); setDirty(true); };
  const addRow = () => {
    const p = view.projects[0];
    if (!p) return;
    setRows((rs) => [...rs, { key: `n${Date.now()}`, projectId: p.id, taskId: null, billable: p.billable, note: "", cells: ["", "", "", "", "", "", ""] }]);
    setDirty(true);
  };
  const dayTotal = (d: number) => rows.reduce((t, r) => t + (parseDuration(r.cells[d]) ?? 0), 0);
  const rowTotal = (r: Row) => r.cells.reduce((t, c) => t + (parseDuration(c) ?? 0), 0);
  const total = rows.reduce((t, r) => t + rowTotal(r), 0);
  const billable = rows.filter((r) => r.billable).reduce((t, r) => t + rowTotal(r), 0);

  const collect = (): GridRow[] | null => {
    const errs: Record<string, string> = {};
    const out: GridRow[] = rows.map((r) => ({
      projectId: r.projectId, taskId: r.taskId, billable: r.billable, note: r.note,
      minutes: r.cells.map((c, d) => { const m = parseDuration(c); if (m == null) errs[`${r.key}.${d}`] = "Use hours like 8, 8.5 or 8:30."; return m ?? 0; }),
    }));
    setErrors(errs);
    if (Object.keys(errs).length) { toast.error("Some cells aren't valid hours."); return null; }
    return out;
  };
  const run = (kind: "save" | "submit") => {
    const data = collect();
    if (!data) return;
    start(async () => {
      const r = kind === "save" ? await saveWeekAction(view.weekStart, data) : await submitWeekAction(view.weekStart, data);
      if (!r.ok) { toast.error(r.error); if (r.field?.startsWith("day.") || r.field?.startsWith("rows.")) setErrors({ [r.field]: r.error }); return; }
      setDirty(false);
      toast.success(kind === "save" ? "Timesheet saved" : "Timesheet submitted", kind === "submit" ? { description: "Your approvers have been told." } : undefined);
      router.refresh();
    });
  };
  const withdraw = () => start(async () => {
    const r = await withdrawWeekAction(view.weekStart);
    if (r.ok) toast.success("Submission withdrawn"); else toast.error(r.error);
  });
  const go = (w: string) => router.push(`/me/timesheet?week=${w}`);
  const thisWeek = addDaysISO(today, -((new Date(today + "T00:00:00Z").getUTCDay() + 6) % 7));

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <Card>
          <div className="flex flex-wrap items-center gap-2 px-5 py-4">
            <IconButton label="Previous week" size="icon-sm" onClick={() => go(addDaysISO(view.weekStart, -7))}><ChevronLeft /></IconButton>
            <IconButton label="Next week" size="icon-sm" onClick={() => go(addDaysISO(view.weekStart, 7))}><ChevronRight /></IconButton>
            <h2 className="text-md font-semibold">{fmtWeek(view.weekStart)}</h2>
            {view.weekStart !== thisWeek && <Button variant="link" size="sm" onClick={() => go(thisWeek)}>This week</Button>}
            <div className="ml-auto flex items-center gap-2">
              {view.locked && <Badge tone="neutral"><Lock />Locked</Badge>}
              {view.status && <StatusChip status={CHIP[view.status]} label={TIMESHEET_STATUS_LABEL[view.status]} />}
            </div>
          </div>
          {view.status === "rejected" && <Banner tone="warning" className="mx-5 mb-4" title="Sent back for changes">{view.comment ?? "Your approver asked for changes. Fix the week and submit it again."}</Banner>}
          {view.status === "draft" && view.comment && <Banner tone="info" className="mx-5 mb-4" title="Reopened by an admin">{view.comment}</Banner>}
          {view.locked && view.status !== "approved" && <Banner tone="info" className="mx-5 mb-4" title="This week is locked">Weeks older than {view.policy.lock_after_days} days can&apos;t be changed. Ask a project admin if something is wrong.</Banner>}
          {view.invoiced && <Banner tone="info" className="mx-5 mb-4" title="Invoiced">Some of these hours are on a client invoice.</Banner>}
          {view.projects.length === 0 ? (
            <EmptyState icon={<CalendarClock />} title="You're not on any project yet" description="Once a project admin adds you to a project, you can log hours against it here." />
          ) : (
            <div className="overflow-x-auto border-t border-border">
              <table className="w-full min-w-[900px] border-collapse text-base">
                <caption className="sr-only">Hours per project and day</caption>
                <thead className="bg-surface-sunken text-sm text-text-muted">
                  <tr>
                    <th scope="col" className="px-3 py-2 text-left font-medium">Project / task</th>
                    {view.days.map((d, i) => (
                      <th key={d} scope="col" className={"w-20 px-1 py-2 text-center font-medium " + (d === today ? "text-accent-text" : "")}>{DAY[i]}<span className="block text-xs font-normal">{fmtDay(d)}</span></th>
                    ))}
                    <th scope="col" className="w-16 px-2 py-2 text-right font-medium">Total</th>
                    <th scope="col" className="w-14 px-2 py-2 text-center font-medium">Bill</th>
                    <th scope="col" className="w-44 px-2 py-2 text-left font-medium">Note</th>
                    <th scope="col" className="w-10"><span className="sr-only">Remove</span></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const p = projectOf(r.projectId);
                    return (
                      <tr key={r.key} className="border-t border-border align-top">
                        <td className="px-3 py-2">
                          <div className="flex flex-col gap-1.5">
                            <Select size="sm" value={r.projectId} disabled={!editable} options={view.projects.map((x) => ({ value: x.id, label: `${x.code} · ${x.name}` }))}
                              onValueChange={(v) => { const np = projectOf(v); update(r.key, { projectId: v, taskId: null, billable: !!np?.billable }); }} />
                            {p && p.tasks.length > 0 && (
                              <Select size="sm" value={r.taskId ?? "__none"} disabled={!editable} placeholder="Task (optional)"
                                options={[{ value: "__none", label: "No task" }, ...p.tasks.map((t) => ({ value: t.id, label: t.name }))]}
                                onValueChange={(v) => { const t = p.tasks.find((x) => x.id === v); update(r.key, { taskId: v === "__none" ? null : v, billable: p.billable && (t ? t.is_billable : r.billable) }); }} />
                            )}
                            {errors[`rows.${rows.indexOf(r)}`] && <p role="alert" className="text-xs text-danger-text">{errors[`rows.${rows.indexOf(r)}`]}</p>}
                          </div>
                        </td>
                        {r.cells.map((c, d) => {
                          const err = errors[`${r.key}.${d}`] ?? errors[`rows.${rows.indexOf(r)}.${d}`];
                          return (
                            <td key={d} className="px-1 py-2">
                              <Input inputSize="sm" value={c} disabled={!editable} inputMode="decimal" aria-label={`${p?.code ?? "Project"} ${DAY[d]} hours`} aria-invalid={!!err || undefined} title={err}
                                className={"text-center tabular " + (err ? "border-danger" : "")} placeholder="–"
                                onChange={(e) => { const cells = [...r.cells]; cells[d] = e.target.value; update(r.key, { cells }); }} />
                            </td>
                          );
                        })}
                        <td className="px-2 py-3 text-right font-medium tabular">{formatMinutes(rowTotal(r))}</td>
                        <td className="px-2 py-3 text-center">
                          <Checkbox aria-label="Billable" checked={r.billable} disabled={!editable || !p?.billable} onCheckedChange={(v) => update(r.key, { billable: !!v })} />
                        </td>
                        <td className="px-2 py-2">
                          <Input inputSize="sm" value={r.note} disabled={!editable} maxLength={500} placeholder={view.policy.require_note ? "Required" : "What you worked on"} aria-label="Note"
                            aria-invalid={!!errors[`rows.${rows.indexOf(r)}.note`] || undefined} onChange={(e) => update(r.key, { note: e.target.value })} />
                        </td>
                        <td className="px-1 py-2">
                          {editable && <IconButton label="Remove row" size="icon-sm" onClick={() => { setRows((rs) => rs.filter((x) => x.key !== r.key)); setDirty(true); }}><Trash2 /></IconButton>}
                        </td>
                      </tr>
                    );
                  })}
                  {rows.length === 0 && <tr className="border-t border-border"><td colSpan={11} className="px-3 py-6 text-center text-text-muted">No hours logged this week yet.</td></tr>}
                </tbody>
                <tfoot className="bg-surface-sunken text-sm">
                  <tr className="border-t border-border">
                    <td className="px-3 py-2 font-medium">Daily total</td>
                    {view.days.map((d, i) => {
                      const m = dayTotal(i), over = m > view.policy.max_minutes_per_day, err = errors[`day.${i}`];
                      return <td key={d} className={"px-1 py-2 text-center font-medium tabular " + (over || err ? "text-danger-text" : "")} title={err}>{m ? formatMinutes(m) : "–"}</td>;
                    })}
                    <td className="px-2 py-2 text-right font-semibold tabular">{formatMinutes(total)}</td>
                    <td colSpan={3} className="px-2 py-2 text-text-muted">{formatMinutes(billable)} billable</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {view.projects.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
              {editable && <Button variant="secondary" size="sm" onClick={addRow}><Plus />Add row</Button>}
              <p className="text-sm text-text-muted">
                {view.policy.min_minutes_per_week > 0 && `At least ${formatMinutes(view.policy.min_minutes_per_week)} a week. `}
                {view.policy.cadence === "daily" && view.policy.min_minutes_per_day > 0 && `At least ${formatMinutes(view.policy.min_minutes_per_day)} on weekdays. `}
                Up to {formatMinutes(view.policy.max_minutes_per_day)} a day.
              </p>
              <div className="ml-auto flex gap-2">
                {view.actions.withdraw && <Button variant="secondary" onClick={withdraw} loading={busy}><Undo2 />Withdraw</Button>}
                {editable && <Button variant="secondary" onClick={() => run("save")} loading={busy} disabled={!dirty && !!view.timesheetId}>Save draft</Button>}
                {view.actions.submit && <Button onClick={() => run("submit")} loading={busy}><Send />Submit for approval</Button>}
              </div>
            </div>
          )}
        </Card>
        {view.steps.length > 0 && (
          <Card>
            <CardHeader title="Approval" description={view.submittedAt ? `Submitted ${new Date(view.submittedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}` : undefined} />
            <div className="px-5 pb-5">
              <ApprovalTimeline levels={view.steps.map((s) => ({ level: s.level, approver: s.approver, role: s.title ?? undefined, status: (s.status === "skipped" ? "waiting" : s.status) as "approved" | "rejected" | "pending" | "waiting", comment: s.comment ?? undefined, at: s.acted_at ? new Date(s.acted_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : undefined }))} />
            </div>
          </Card>
        )}
      </div>
      <div className="flex w-full flex-col gap-4 lg:w-72 lg:shrink-0">
        {toApprove > 0 && (
          <Card className="p-4">
            <p className="flex items-center gap-2 text-base font-medium"><ClipboardCheck className="size-4 text-accent-text" aria-hidden />{toApprove} {toApprove === 1 ? "timesheet" : "timesheets"} to approve</p>
            <Button asChild variant="secondary" size="sm" className="mt-3"><Link href="/psa/approvals">Review them</Link></Button>
          </Card>
        )}
        <Card>
          <CardHeader title="Recent weeks" />
          {recent.length === 0 ? <p className="px-5 pb-5 text-sm text-text-muted">Nothing logged yet.</p> : (
            <ul className="divide-y divide-border border-t border-border">
              {recent.map((w) => (
                <li key={w.week_start}>
                  <Link href={`/me/timesheet?week=${w.week_start}`} aria-current={w.week_start === view.weekStart ? "page" : undefined} className={"flex items-center justify-between gap-2 px-5 py-2.5 text-base hover:bg-surface-hover " + (w.week_start === view.weekStart ? "bg-surface-sunken" : "")}>
                    <span className="truncate">{fmtWeek(w.week_start)}</span>
                    <span className="flex items-center gap-2 text-sm text-text-muted"><span className="tabular">{formatMinutes(w.total_minutes)}</span><StatusChip status={CHIP[w.status]} label={TIMESHEET_STATUS_LABEL[w.status]} /></span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
