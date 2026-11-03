"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ClipboardList, Plus, UserMinus } from "lucide-react";
import { Card, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Drawer, Modal } from "@/ui/overlay";
import { Banner, EmptyState, Skeleton } from "@/ui/feedback";
import { ApprovalTimeline } from "@/ui/flow";
import { DataTable } from "@/ui/table";
import { toast } from "@/ui/toast";
import { JOB_TYPES, jobTypeLabel, REQ_STATUSES } from "@/server/modules/hire/rules";
import type { ReqRow } from "@/server/modules/hire/jobs";
import { requisitionAction, requisitionDetailAction, saveRequisitionAction } from "@/app/(app)/hire/actions";
import { day, inr0 } from "./shared";

type Backfill = { employee_id: string; name: string; designation: string | null; department_id: string | null; location_id: string | null; last_working_date: string; status: string };
const TONE: Record<string, "neutral" | "warning" | "success" | "danger" | "accent"> = { draft: "neutral", pending: "warning", sent_back: "warning", approved: "accent", rejected: "danger", converted: "success", closed: "neutral" };
export const ReqStatus = ({ status }: { status: string }) => <Badge tone={TONE[status] ?? "neutral"}>{REQ_STATUSES.find((s) => s.value === status)?.label ?? status}</Badge>;

/** S133–S134: requisitions (headcount requests) with their approval, plus people leaving who may need a backfill. */
export function Requisitions({ rows, backfills, departments, locations, canRaise, canConvert, me, openNew }: {
  rows: ReqRow[]; backfills: Backfill[]; departments: { id: string; name: string }[]; locations: { id: string; name: string }[]; canRaise: boolean; canConvert: boolean; me: string; openNew: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<ReqRow | "new" | Backfill | null>(openNew && canRaise ? "new" : null);
  const [open, setOpen] = React.useState<ReqRow | null>(null);
  const [, start] = React.useTransition();
  const run = (r: ReqRow, action: string, msg: string) => start(async () => {
    const res = await requisitionAction(r.id, action);
    if (!res.ok) { toast.error(res.error); return; }
    toast.success(msg); setOpen(null);
    const jobId = (res.data as { jobId?: string } | undefined)?.jobId;
    if (jobId) router.push(`/hire/jobs/${jobId}/edit`);
  });
  return (
    <div className="flex flex-col gap-4">
      {canRaise && backfills.length > 0 && (
        <Card>
          <CardHeader title="People leaving" description="No requisition raised to replace them yet." />
          <ul className="divide-y divide-border border-t border-border">
            {backfills.map((b) => (
              <li key={b.employee_id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <UserMinus aria-hidden className="size-4 text-text-muted" />
                <span className="flex-1"><span className="font-medium">{b.name}</span><span className="text-sm text-text-muted"> · {b.designation ?? "—"} · last day {day(b.last_working_date)}</span></span>
                <Button size="sm" variant="secondary" onClick={() => setEditing(b)}>Raise a backfill</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {canRaise && <Button className="self-start" onClick={() => setEditing("new")}><Plus />Raise requisition</Button>}
      <DataTable caption="Requisitions" rows={rows} rowKey={(r) => r.id} onRowClick={setOpen}
        empty={<EmptyState icon={<ClipboardList />} title="No requisitions yet" description="Raise one when your team needs to hire." />}
        columns={[
          { key: "title", header: "Position", sortValue: (r) => r.title, cell: (r) => <div><span className="font-medium">{r.title}</span><p className="text-sm text-text-muted">{[r.department, r.location].filter(Boolean).join(" · ") || "—"}{r.backfill_for ? ` · replaces ${r.backfill_for}` : ""}</p></div> },
          { key: "openings", header: "Openings", align: "right", cell: (r) => r.openings },
          { key: "by", header: "Raised by", hideBelow: "md", cell: (r) => <span className="text-sm">{r.raised_by}<span className="block text-text-muted">{day(r.created_at)}</span></span> },
          { key: "status", header: "Status", cell: (r) => <ReqStatus status={r.status} /> },
          { key: "job", header: "", hideBelow: "md", cell: (r) => r.job_id ? <Link href={`/hire/jobs/${r.job_id}`} onClick={(e) => e.stopPropagation()} className="text-sm text-accent-text hover:underline">Open job</Link> : null },
        ]} />
      <Drawer open={!!open} onOpenChange={(o) => !o && setOpen(null)} title={open?.title ?? ""} description={open ? `${open.openings} ${open.openings === 1 ? "opening" : "openings"} · ${jobTypeLabel(open.job_type)}` : undefined}
        footer={open && (
          <>
            {open.raised_by_id === me && ["draft", "sent_back"].includes(open.status) && <><Button variant="secondary" onClick={() => { setEditing(open); setOpen(null); }}>Edit</Button><Button onClick={() => run(open, "submit", "Sent for approval")}>Send for approval</Button></>}
            {open.raised_by_id === me && open.status === "pending" && <Button variant="secondary" onClick={() => run(open, "withdraw", "Pulled back to draft")}>Pull back</Button>}
            {canConvert && open.status === "approved" && <Button onClick={() => run(open, "convert", "Job created as a draft")}>Create job</Button>}
            {(open.raised_by_id === me || canConvert) && ["draft", "sent_back", "approved", "pending", "rejected"].includes(open.status) && <Button variant="ghost" onClick={() => run(open, "close", "Requisition closed")}>Close</Button>}
          </>
        )}>
        {open && <ReqDetail row={open} />}
      </Drawer>
      {editing && <ReqDialog initial={editing} departments={departments} locations={locations} onClose={() => setEditing(null)} />}
    </div>
  );
}

export function ReqDetail({ row }: { row: ReqRow }) {
  const [steps, setSteps] = React.useState<Awaited<ReturnType<typeof requisitionDetailAction>> | null>(null);
  React.useEffect(() => { let live = true; requisitionDetailAction(row.id).then((r) => { if (live) setSteps(r); }); return () => { live = false; }; }, [row.id]);
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-base">
        <div><dt className="text-sm text-text-muted">Status</dt><dd className="mt-1"><ReqStatus status={row.status} /></dd></div>
        <div><dt className="text-sm text-text-muted">Fill by</dt><dd>{day(row.target_date)}</dd></div>
        <div><dt className="text-sm text-text-muted">Department</dt><dd>{row.department ?? "—"}</dd></div>
        <div><dt className="text-sm text-text-muted">Location</dt><dd>{row.location ?? "—"}</dd></div>
        <div><dt className="text-sm text-text-muted">Salary range</dt><dd>{row.salary_min_paise != null || row.salary_max_paise != null ? `${row.salary_min_paise != null ? inr0(row.salary_min_paise) : "…"} – ${row.salary_max_paise != null ? inr0(row.salary_max_paise) : "…"}` : "—"}</dd></div>
        <div><dt className="text-sm text-text-muted">Experience</dt><dd>{row.experience_min != null || row.experience_max != null ? `${row.experience_min ?? 0}–${row.experience_max ?? "any"} years` : "—"}</dd></div>
        {row.backfill_for && <div className="col-span-2"><dt className="text-sm text-text-muted">Replaces</dt><dd>{row.backfill_for}</dd></div>}
        {row.description && <div className="col-span-2"><dt className="text-sm text-text-muted">Why</dt><dd className="mt-1 whitespace-pre-line rounded-md bg-surface-sunken px-3 py-2">{row.description}</dd></div>}
        {row.qualification && <div className="col-span-2"><dt className="text-sm text-text-muted">Qualifications</dt><dd className="whitespace-pre-line">{row.qualification}</dd></div>}
      </dl>
      <div>
        <h3 className="mb-3 text-sm font-semibold">Approvals</h3>
        {!steps ? <Skeleton className="h-16" /> : !steps.ok ? <p className="text-sm text-danger-text">{steps.error}</p> : steps.data!.steps.length === 0 ? <p className="text-sm text-text-muted">Not sent for approval yet.</p> : (
          <ApprovalTimeline levels={steps.data!.steps.map((s) => ({ level: s.level, approver: s.approver, role: s.title ?? undefined, status: s.status === "skipped" ? "waiting" : s.status, comment: s.comment ?? undefined, at: s.acted_at ? new Date(s.acted_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : undefined }))} />
        )}
      </div>
    </div>
  );
}

function ReqDialog({ initial, departments, locations, onClose }: { initial: ReqRow | "new" | Backfill; departments: { id: string; name: string }[]; locations: { id: string; name: string }[]; onClose: () => void }) {
  const row = typeof initial === "object" && "title" in initial ? initial : null;
  const bf = typeof initial === "object" && "employee_id" in initial ? initial : null;
  const [f, setF] = React.useState({
    title: row?.title ?? bf?.designation ?? "", openings: String(row?.openings ?? 1), jobType: row?.job_type ?? "full_time", departmentId: row?.department_id ?? bf?.department_id ?? "", locationId: row?.location_id ?? bf?.location_id ?? "",
    salaryMin: row?.salary_min_paise != null ? String(row.salary_min_paise / 100) : "", salaryMax: row?.salary_max_paise != null ? String(row.salary_max_paise / 100) : "", targetDate: row?.target_date ?? bf?.last_working_date ?? "",
    description: row?.description ?? (bf ? `Backfill for ${bf.name}.` : ""), qualification: row?.qualification ?? "", experienceMin: row?.experience_min?.toString() ?? "", experienceMax: row?.experience_max?.toString() ?? "",
    backfillForId: row?.backfill_for_employee_id ?? bf?.employee_id ?? "",
  });
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [busy, start] = React.useTransition();
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const err = (k: string) => (error?.field === k ? error.message : undefined);
  const save = (submit: boolean) => start(async () => {
    setError(null);
    const r = await saveRequisitionAction(row?.id ?? null, f, submit);
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success(submit ? (r.data!.status === "approved" ? "Approved (no one needed to approve it)" : "Sent for approval") : "Saved as a draft");
    onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="lg" title={row ? "Edit requisition" : bf ? `Backfill for ${bf.name}` : "Raise a requisition"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="secondary" loading={busy} onClick={() => save(false)}>Save draft</Button><Button loading={busy} onClick={() => save(true)}>Send for approval</Button></>}>
      <div className="flex flex-col gap-4">
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field className="sm:col-span-2" label="Position" required error={err("title")}><Input value={f.title} onChange={(e) => set("title", e.target.value)} maxLength={120} placeholder="e.g. Backend Engineer" /></Field>
          <Field label="Openings" required error={err("openings")}><Input type="number" min={1} value={f.openings} onChange={(e) => set("openings", e.target.value)} /></Field>
          <Field label="Type" error={err("jobType")}><Select value={f.jobType} onValueChange={(v) => set("jobType", v)} options={JOB_TYPES.map((t) => ({ value: t.value, label: t.label }))} /></Field>
          <Field label="Department" error={err("departmentId")}><Select value={f.departmentId} onValueChange={(v) => set("departmentId", v)} placeholder="Pick one" options={departments.map((d) => ({ value: d.id, label: d.name }))} /></Field>
          <Field label="Location" error={err("locationId")}><Select value={f.locationId} onValueChange={(v) => set("locationId", v)} placeholder="Pick one" options={locations.map((d) => ({ value: d.id, label: d.name }))} /></Field>
          <Field label="Salary from (₹ a year)" error={err("salaryMinPaise")}><Input inputMode="numeric" value={f.salaryMin} onChange={(e) => set("salaryMin", e.target.value)} /></Field>
          <Field label="Salary up to (₹ a year)" error={err("salaryMaxPaise")}><Input inputMode="numeric" value={f.salaryMax} onChange={(e) => set("salaryMax", e.target.value)} /></Field>
          <Field label="Least experience (years)" error={err("experienceMin")}><Input type="number" min={0} value={f.experienceMin} onChange={(e) => set("experienceMin", e.target.value)} /></Field>
          <Field label="Most experience (years)" error={err("experienceMax")}><Input type="number" min={0} value={f.experienceMax} onChange={(e) => set("experienceMax", e.target.value)} /></Field>
          <Field label="Fill by" error={err("targetDate")}><Input type="date" value={f.targetDate} onChange={(e) => set("targetDate", e.target.value)} /></Field>
        </div>
        <Field label="Why do you need this role?" error={err("description")}><Textarea value={f.description} onChange={(e) => set("description", e.target.value)} maxLength={5000} /></Field>
        <Field label="Qualifications"><Textarea value={f.qualification} onChange={(e) => set("qualification", e.target.value)} maxLength={1000} rows={2} /></Field>
        {f.backfillForId && <p className="text-sm text-text-muted">This is a backfill. {err("backfillForId")}</p>}
      </div>
    </Modal>
  );
}
