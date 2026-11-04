"use client";
import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { CheckCircle2, FileDown, FileText, Inbox, Paperclip, Send, Sparkles, Trash2, Upload } from "lucide-react";
import { Card, CardBody, CardHeader, StatTile } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { ConfirmDialog, Modal } from "@/ui/overlay";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Segmented } from "@/ui/choice";
import { Banner, EmptyState } from "@/ui/feedback";
import { DataTable, type Column } from "@/ui/table";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { toast } from "@/ui/toast";
import { deleteForm16Action, generatePartBAction, publishForm16Action, saveTaxSettingsAction, uploadForm16Action, verifyProofAction } from "@/app/(app)/payroll/tax/actions";
import type { ClaimRow } from "@/server/modules/payroll/claims";
import type { fbpOverview } from "@/server/modules/tax/fbp";
import { QUARTERS } from "@/server/modules/payrun/tds24q";
import { ClaimStatusBadge } from "@/features/payroll/claims-ui";
import { DEFAULT_TAX_SETTINGS, SECTION_LABEL, type Section, type TaxSettings } from "@/server/modules/tax/rules";
import type { declarationsOverview, form16List, listTaxSettings, ProofRow } from "@/server/modules/tax/service";
import { Money, paiseText, ProofStatus, RupeeInput, shortDate, toPaise } from "./shared";

type Tab = "proofs" | "declarations" | "fbp" | "claims" | "form16" | "returns" | "windows";
type Fbp = Awaited<ReturnType<typeof fbpOverview>>;
type People = Awaited<ReturnType<typeof declarationsOverview>>;
type Form16 = Awaited<ReturnType<typeof form16List>>;
type Settings = Awaited<ReturnType<typeof listTaxSettings>>;
export type TaxDeskData = {
  fy: string; fyLabel: string; fyOptions: { value: string; label: string }[]; today: string; companyWide: boolean;
  pending: ProofRow[]; reviewed: ProofRow[]; people: People; form16: Form16; settings: Settings; fbp: Fbp; claims: ClaimRow[];
};

export function TaxDesk({ d, tab }: { d: TaxDeskData; tab: Tab }) {
  const router = useRouter();
  const path = usePathname();
  const [current, setCurrent] = React.useState<Tab>(tab);
  const go = (next: { fy?: string; tab?: Tab }) => router.replace(`${path}?${new URLSearchParams({ fy: next.fy ?? d.fyLabel, tab: next.tab ?? current })}`, { scroll: false });
  const submitted = d.people.filter((p) => p.status !== "none" && p.status !== "draft").length;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Financial year" className="w-44"><Select value={d.fy} onValueChange={(v) => go({ fy: d.fyOptions.find((o) => o.value === v)?.label.replace("FY ", "") })} options={d.fyOptions} /></Field>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatTile label="Proofs to check" value={String(d.pending.filter((p) => p.canVerify).length)} hint={d.pending.some((p) => p.mine) ? "Your own proofs are checked by another admin" : undefined} />
        <StatTile label="Declarations submitted" value={`${submitted} of ${d.people.length}`} />
        <StatTile label="Form 16 shared" value={`${d.form16.filter((f) => f.publishedAt).length} of ${d.form16.length}`} />
      </div>
      <Tabs value={current} onValueChange={(v) => { setCurrent(v as Tab); go({ tab: v as Tab }); }}>
        <TabsList items={[{ value: "proofs", label: "Proofs", count: d.pending.length || undefined }, { value: "declarations", label: "Declarations" }, { value: "fbp", label: "Flexible benefits" },
          { value: "claims", label: "Reimbursable claims", count: d.claims.filter((c) => c.status === "submitted").length || undefined }, { value: "form16", label: "Form 16" }, { value: "returns", label: "Returns" }, { value: "windows", label: "Windows" }]} />
        <TabsContent value="proofs"><Proofs d={d} /></TabsContent>
        <TabsContent value="declarations"><Declarations d={d} /></TabsContent>
        <TabsContent value="fbp"><FbpOverview d={d} /></TabsContent>
        <TabsContent value="claims"><ClaimsDesk d={d} /></TabsContent>
        <TabsContent value="form16"><Form16Tab d={d} /></TabsContent>
        <TabsContent value="returns"><Returns d={d} /></TabsContent>
        <TabsContent value="windows"><Windows d={d} /></TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------- proofs
function Proofs({ d }: { d: TaxDeskData }) {
  const [view, setView] = React.useState<"pending" | "reviewed">("pending");
  const [open, setOpen] = React.useState<ProofRow | null>(null);
  const rows = view === "pending" ? d.pending : d.reviewed;
  return (
    <div className="flex flex-col gap-4">
      <Segmented label="Show" value={view} onChange={setView} options={[{ value: "pending", label: `To check (${d.pending.length})` }, { value: "reviewed", label: `Checked (${d.reviewed.length})` }]} />
      {rows.length === 0 ? (
        <Card><EmptyState icon={view === "pending" ? <CheckCircle2 /> : <Inbox />} title={view === "pending" ? "No proofs waiting" : "Nothing checked yet"} description={view === "pending" ? "People send proofs in the proof window you set." : undefined} /></Card>
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-col gap-2 px-5 py-4 md:flex-row md:items-center md:gap-4">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-base font-medium"><span>{r.employee}{r.mine ? " (you)" : ""}</span><ProofStatus status={r.proofStatus} /></p>
                  <p className="text-sm text-text-muted">{SECTION_LABEL[r.section as Section] ?? r.section} · {r.label} · declared <Money paise={r.declaredPaise} />{r.acceptedPaise != null && view === "reviewed" ? <> · accepted <Money paise={r.acceptedPaise} /></> : null}</p>
                  {r.detail && <p className="text-sm text-text-muted">{r.detail}</p>}
                  <ul className="mt-1 flex flex-wrap gap-2">{r.files.map((f) => <li key={f.id}><a href={`/tax/files/${f.id}`} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-sm text-accent-text underline-offset-4 hover:underline"><Paperclip aria-hidden className="size-3.5" />{f.name}</a></li>)}</ul>
                </div>
                {r.canVerify ? <Button size="sm" onClick={() => setOpen(r)}>Check</Button> : r.mine && r.proofStatus === "submitted" ? <span className="text-sm text-text-muted">Another admin checks yours</span> : null}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {open && <Verify row={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Verify({ row, onClose }: { row: ProofRow; onClose: () => void }) {
  const [decision, setDecision] = React.useState<"accept" | "partial" | "reject">("accept");
  const [amount, setAmount] = React.useState(paiseText(row.declaredPaise));
  const [comment, setComment] = React.useState("");
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    const acceptedPaise = decision === "partial" ? toPaise(amount) : undefined;
    if (decision === "partial" && acceptedPaise == null) { setError({ message: "Enter the accepted amount in rupees.", field: "acceptedPaise" }); return; }
    const r = await verifyProofAction(row.id, { decision, acceptedPaise: acceptedPaise ?? undefined, comment });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success(decision === "accept" ? "Proof accepted" : decision === "reject" ? "Proof rejected" : "Proof partly accepted", { description: `${row.employee} has been told.` });
    onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={`Check ${row.employee}'s proof`} description={`${row.label}, declared ${paiseText(row.declaredPaise) ? "₹" + paiseText(row.declaredPaise) : "₹0"}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} variant={decision === "reject" ? "danger" : "primary"} onClick={save}>{decision === "accept" ? "Accept" : decision === "reject" ? "Reject" : "Accept part"}</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <ul className="flex flex-col gap-1">{row.files.map((f) => <li key={f.id}><a href={`/tax/files/${f.id}`} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-base text-accent-text underline-offset-4 hover:underline"><FileText aria-hidden className="size-4" />Open {f.name}</a></li>)}</ul>
        {row.detail && <p className="text-sm text-text-muted">{row.detail}</p>}
        <Segmented label="Decision" value={decision} onChange={setDecision} options={[{ value: "accept", label: "Accept all" }, { value: "partial", label: "Accept part" }, { value: "reject", label: "Reject" }]} />
        {decision === "partial" && <Field label="Accepted amount" required error={error?.field === "acceptedPaise" ? error.message : undefined} help="More than ₹0 and less than what was declared"><RupeeInput value={amount} onChange={setAmount} /></Field>}
        <Field label="Comment" required={decision !== "accept"} error={error?.field === "comment" ? error.message : undefined} help="Shared with the employee">
          <Textarea value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} placeholder={decision === "reject" ? "e.g. The receipt is for last year" : undefined} />
        </Field>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------- declarations
function Declarations({ d }: { d: TaxDeskData }) {
  const cols: Column<People[number]>[] = [
    { key: "name", header: "Person", cell: (r) => <span className="font-medium">{r.name}</span>, sortValue: (r) => r.name },
    { key: "status", header: "Status", cell: (r) => r.status === "none" ? <Badge tone="neutral">Not started</Badge> : r.status === "draft" ? <Badge tone="warning">Draft</Badge> : <Badge tone="success">Submitted</Badge>, sortValue: (r) => r.status },
    { key: "regime", header: "Regime", cell: (r) => (r.regime ? (r.regime === "new" ? "New" : "Old") : "—"), hideBelow: "md" },
    { key: "declared", header: "Declared", align: "right", cell: (r) => <Money paise={r.declaredPaise} />, sortValue: (r) => r.declaredPaise },
    { key: "proofs", header: "Proofs to check", align: "right", cell: (r) => r.pendingProofs || "—", sortValue: (r) => r.pendingProofs, hideBelow: "md" },
    { key: "pan", header: "PAN", cell: (r) => (r.hasPan ? "On file" : <span className="text-warning-text">Missing</span>), hideBelow: "lg" },
    { key: "pdf", header: <span className="sr-only">Summary</span>, cell: (r) => r.status !== "none" ? <a className="inline-flex items-center gap-1 text-sm text-accent-text underline-offset-4 hover:underline" href={`/me/tax/form-12bb?fy=${d.fyLabel}&employee=${r.employeeId}`}><FileDown aria-hidden className="size-3.5" />PDF</a> : null },
  ];
  return <DataTable rows={d.people} columns={cols} rowKey={(r) => r.employeeId} caption={`Declarations for FY ${d.fyLabel}`} empty={<EmptyState compact icon={<Inbox />} title="Nobody to show" />} />;
}

// ---------------------------------------------------------------- Form 16
function Form16Tab({ d }: { d: TaxDeskData }) {
  const input = React.useRef<HTMLInputElement>(null);
  const [report, setReport] = React.useState<{ matched: { file: string; employee: string; replaced: boolean }[]; unmatched: { file: string; reason: string }[] } | null>(null);
  const [pending, start] = React.useTransition();
  const [removing, setRemoving] = React.useState<Form16[number] | null>(null);
  const unpublished = d.form16.filter((f) => (f.file || f.partB) && !f.publishedAt).length;
  const withPay = d.form16.filter((f) => f.paidMonths > 0).length;
  const generate = (ids: string[] | "all") => start(async () => {
    const r = await generatePartBAction(d.fy, ids);
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(`Part B generated for ${r.data!.generated} ${r.data!.generated === 1 ? "person" : "people"}`, { description: r.data!.skipped.length ? `${r.data!.skipped.length} skipped: no finalised pay in the year.` : "Share them when you're ready." });
  });
  const upload = (files: FileList | null) => {
    if (!files?.length) return;
    const form = new FormData(); form.set("fyStart", d.fy);
    for (const f of Array.from(files)) form.append("files", f);
    start(async () => {
      const r = await uploadForm16Action(form);
      if (input.current) input.current.value = "";
      if (!r.ok) { toast.error(r.error); return; }
      setReport(r.data!);
      toast.success(`${r.data!.matched.length} file${r.data!.matched.length === 1 ? "" : "s"} matched`);
    });
  };
  const cols: Column<Form16[number]>[] = [
    { key: "name", header: "Person", cell: (r) => <span className="font-medium">{r.name}</span>, sortValue: (r) => r.name },
    { key: "pan", header: "PAN", cell: (r) => (r.panLast4 ? `••••••${r.panLast4}` : <span className="text-warning-text">Missing</span>), hideBelow: "md" },
    { key: "file", header: "Part A", cell: (r) => (r.file ? <a href={`/tax/files/${r.file.id}`} target="_blank" rel="noopener" className="text-accent-text underline-offset-4 hover:underline">{r.file.name}</a> : "Not uploaded") },
    { key: "partb", header: "Part B", cell: (r) => (r.partB ? <a href={`/tax/files/${r.partB.id}`} target="_blank" rel="noopener" className="text-accent-text underline-offset-4 hover:underline">{r.partB.name}</a> : r.paidMonths ? <span className="text-text-muted">Not generated</span> : <span className="text-text-muted">No pay this year</span>) },
    { key: "pub", header: "Shared", cell: (r) => (r.publishedAt ? shortDate(r.publishedAt) : r.file || r.partB ? <Badge tone="warning">Not yet</Badge> : "—"), hideBelow: "md" },
    { key: "act", header: <span className="sr-only">Actions</span>, align: "right", cell: (r) => d.companyWide && (r.docId || r.paidMonths > 0) ? (
      <div className="flex justify-end gap-1">
        {r.paidMonths > 0 && <Button size="sm" variant="ghost" disabled={pending} onClick={() => generate([r.employeeId])}>{r.partB ? "Regenerate B" : "Generate B"}</Button>}
        {(r.file || r.partB) && !r.publishedAt && <Button size="sm" variant="secondary" onClick={() => start(async () => { const x = await publishForm16Action(d.fy, [r.employeeId]); if (x.ok) toast.success(`Shared with ${r.name}`); else toast.error(x.error); })}>Share</Button>}
        {r.docId && <IconButton label={`Remove ${r.name}'s Form 16`} variant="ghost" size="icon-sm" onClick={() => setRemoving(r)}><Trash2 /></IconButton>}
      </div>
    ) : null },
  ];
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={`Form 16 Part A for FY ${d.fyLabel}`} description="Download Part A from the TRACES portal, then upload the ZIP (or the PDFs) here. Each file must be named starting with the employee's PAN, like ABCDE1234F_PartA.pdf." />
        <CardBody className="flex flex-col gap-3">
          {!d.companyWide && <Banner tone="info">Only payroll admins for the whole company can upload and share Form 16.</Banner>}
          {d.companyWide && (
            <div className="flex flex-wrap gap-2">
              <input ref={input} type="file" multiple accept=".zip,.pdf" className="sr-only" id="form16-files" onChange={(e) => upload(e.target.files)} />
              <Button loading={pending} onClick={() => input.current?.click()}><Upload />Upload ZIP or PDFs</Button>
              <Button variant="secondary" disabled={!withPay || pending} onClick={() => generate("all")}><FileText />Generate Part B for everyone ({withPay})</Button>
              <Button variant="secondary" disabled={!unpublished || pending} onClick={() => start(async () => { const r = await publishForm16Action(d.fy, "all"); if (r.ok) toast.success(`Shared ${r.data!.published} Form 16${r.data!.published === 1 ? "" : "s"}`); else toast.error(r.error); })}><Send />Share all ready ({unpublished})</Button>
            </div>
          )}
          <p className="text-sm text-text-muted">Up to 5 MB per upload. Part B is erp&apos;s statement of each person&apos;s salary, exemptions, deductions and tax for the year, built from finalised payroll and submitted declarations on rates a CA has not verified; it carries that note. Sharing publishes whatever parts exist.</p>
          {report && (
            <div className="flex flex-col gap-2 rounded-md bg-surface-sunken p-3 text-base" aria-live="polite">
              <p className="font-medium">{report.matched.length} matched, {report.unmatched.length} not matched</p>
              {report.matched.length > 0 && <ul className="list-disc pl-5 text-sm">{report.matched.map((m) => <li key={m.file}>{m.file} → {m.employee}{m.replaced ? " (replaced the earlier file)" : ""}</li>)}</ul>}
              {report.unmatched.length > 0 && <ul className="list-disc pl-5 text-sm text-danger-text">{report.unmatched.map((m) => <li key={m.file}>{m.file}: {m.reason}</li>)}</ul>}
            </div>
          )}
        </CardBody>
      </Card>
      <DataTable rows={d.form16} columns={cols} rowKey={(r) => r.employeeId} caption={`Form 16 for FY ${d.fyLabel}`} empty={<EmptyState compact icon={<FileText />} title="Nobody to show" />} />
      {removing && <ConfirmDialog open onOpenChange={(o) => !o && setRemoving(null)} title={`Remove ${removing.name}'s Form 16?`} description="The file is deleted; they won't see it any more." confirmLabel="Remove"
        onConfirm={async () => { const r = await deleteForm16Action(removing.docId!); if (r.ok) toast.success("Form 16 removed"); else toast.error(r.error); setRemoving(null); }} />}
    </div>
  );
}

// ---------------------------------------------------------------- windows
const MONTHS = ["04", "05", "06", "07", "08", "09", "10", "11", "12", "01", "02", "03"].map((m) => ({ value: m, label: new Date(`2026-${m}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", timeZone: "UTC" }) }));
const DAYS = Array.from({ length: 31 }, (_, i) => ({ value: String(i + 1).padStart(2, "0"), label: String(i + 1) }));

function MdPicker({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-sm font-medium">{label}</legend>
      <div className="flex gap-2">
        <div className="w-20"><Field label={<span className="sr-only">{label}: day</span>}><Select value={value.slice(3, 5)} onValueChange={(d) => onChange(`${value.slice(0, 2)}-${d}`)} options={DAYS} /></Field></div>
        <div className="flex-1"><Field label={<span className="sr-only">{label}: month</span>}><Select value={value.slice(0, 2)} onValueChange={(m) => onChange(`${m}-${value.slice(3, 5)}`)} options={MONTHS} /></Field></div>
      </div>
    </fieldset>
  );
}

function Windows({ d }: { d: TaxDeskData }) {
  if (!d.settings.length) return <Card><EmptyState icon={<Inbox />} title="No pay groups yet" description="Declaration windows are set per pay group. Add one in Settings → Payroll first." /></Card>;
  return <div className="flex flex-col gap-6">{d.settings.map((g) => <WindowCard key={g.id} group={g} canEdit={d.companyWide} />)}</div>;
}

function WindowCard({ group, canEdit }: { group: Settings[number]; canEdit: boolean }) {
  const [s, setS] = React.useState<TaxSettings>(group.settings);
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    const r = await saveTaxSettingsAction(group.id, s);
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    setError(null); toast.success(`Windows saved for ${group.name}`);
  });
  const monthly = s.editWindow.mode === "monthly" ? s.editWindow : null;
  return (
    <Card>
      <CardHeader title={group.name} description={`${group.people} ${group.people === 1 ? "person" : "people"}. Dates are inside the financial year (April to March).`} />
      <CardBody>
        <form className="flex flex-col gap-5" onSubmit={(e) => { e.preventDefault(); save(); }}>
          {error && <Banner tone="danger">{error.message}</Banner>}
          {!canEdit && <Banner tone="info">Only payroll admins for the whole company can change these.</Banner>}
          <fieldset disabled={!canEdit} className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">When people can change declarations</span>
              <Segmented label="Edit window" value={s.editWindow.mode} onChange={(m) => setS({ ...s, editWindow: m === "always" ? { mode: "always" } : { mode: "monthly", fromDay: 1, toDay: 15 } })}
                options={[{ value: "always", label: "Any day" }, { value: "monthly", label: "Some days each month" }]} />
              {monthly && (
                <div className="grid grid-cols-2 gap-3 sm:w-80">
                  <Field label="From day" error={error?.field === "fromDay" ? error.message : undefined}><Input type="number" min={1} max={28} value={monthly.fromDay} onChange={(e) => setS({ ...s, editWindow: { ...monthly, fromDay: Number(e.target.value) } })} /></Field>
                  <Field label="To day" error={error?.field === "toDay" ? error.message : undefined}><Input type="number" min={1} max={31} value={monthly.toDay} onChange={(e) => setS({ ...s, editWindow: { ...monthly, toDay: Number(e.target.value) } })} /></Field>
                </div>
              )}
            </div>
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Segmented label="Yearly cut-off" value={s.declarationCutoff ? "on" : "off"} onChange={(v) => setS({ ...s, declarationCutoff: v === "on" ? DEFAULT_TAX_SETTINGS.declarationCutoff : null })} options={[{ value: "on", label: "Close on a date" }, { value: "off", label: "Open all year" }]} />
                {s.declarationCutoff && <MdPicker label="Declarations close after" value={s.declarationCutoff} onChange={(v) => setS({ ...s, declarationCutoff: v })} />}
              </div>
              <div className="flex flex-col gap-2">
                <Segmented label="Proof window" value={s.proofWindow ? "on" : "off"} onChange={(v) => setS({ ...s, proofWindow: v === "on" ? DEFAULT_TAX_SETTINGS.proofWindow : null })} options={[{ value: "on", label: "Proofs in a window" }, { value: "off", label: "Proofs any time" }]} />
                {s.proofWindow && (
                  <div className="grid grid-cols-1 gap-3">
                    <MdPicker label="Proofs open" value={s.proofWindow.opens} onChange={(v) => setS({ ...s, proofWindow: { ...s.proofWindow!, opens: v } })} />
                    <MdPicker label="Proofs close (cut-off)" value={s.proofWindow.closes} onChange={(v) => setS({ ...s, proofWindow: { ...s.proofWindow!, closes: v } })} />
                  </div>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <Segmented label="Flexible benefits window" value={s.fbpWindow ? "on" : "off"} onChange={(v) => setS({ ...s, fbpWindow: v === "on" ? { opens: "04-01", closes: "04-30" } : null })} options={[{ value: "on", label: "Choose in a window" }, { value: "off", label: "Any time" }]} />
              {s.fbpWindow && (
                <div className="grid grid-cols-1 gap-3 sm:w-80">
                  <MdPicker label="Flexible benefits open" value={s.fbpWindow.opens} onChange={(v) => setS({ ...s, fbpWindow: { ...s.fbpWindow!, opens: v } })} />
                  <MdPicker label="Flexible benefits close" value={s.fbpWindow.closes} onChange={(v) => setS({ ...s, fbpWindow: { ...s.fbpWindow!, closes: v } })} />
                </div>
              )}
            </div>
            <Field label="Days new joiners get to declare" className="sm:w-80" help="New joiners can declare for this long after joining, even outside the windows." error={error?.field === "lateJoinerDays" ? error.message : undefined}>
              <Input type="number" min={0} max={180} value={s.lateJoinerDays} onChange={(e) => setS({ ...s, lateJoinerDays: Number(e.target.value) })} />
            </Field>
            <p className="text-sm text-text-muted">After the proof cut-off, payroll counts only verified amounts; anything not proven stops reducing tax.</p>
          </fieldset>
          {canEdit && <div className="flex justify-end"><Button type="submit" loading={pending}>Save windows</Button></div>}
        </form>
      </CardBody>
    </Card>
  );
}

// ---------------------------------------------------------------- flexible benefits
function FbpOverview({ d }: { d: TaxDeskData }) {
  const cols: Column<Fbp[number]>[] = [
    { key: "name", header: "Person", cell: (r) => <span className="font-medium">{r.name}</span>, sortValue: (r) => r.name },
    { key: "status", header: "Status", cell: (r) => (r.submittedAt ? <Badge tone="success">Declared {shortDate(r.submittedAt)}</Badge> : <Badge tone="neutral">Nothing declared</Badge>), sortValue: (r) => (r.submittedAt ? 1 : 0) },
    { key: "declared", header: "Declared for the year", align: "right", cell: (r) => <Money paise={r.declaredPaise} />, sortValue: (r) => r.declaredPaise },
    { key: "items", header: "Components", cell: (r) => Object.entries(r.items).map(([k, v]) => `${k} ${paiseText(v) ? "₹" + paiseText(v) : "₹0"}`).join(" · ") || "—", hideBelow: "md" },
  ];
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">Components marked as flexible benefits in Settings → Payroll → Salary components. People choose amounts within each one&apos;s yearly limit; what they declare is exempt in the old regime and claimed later with bills.</p>
      <DataTable rows={d.fbp} columns={cols} rowKey={(r) => r.employeeId} caption={`Flexible benefit declarations for FY ${d.fyLabel}`} empty={<EmptyState compact icon={<Sparkles />} title="Nobody to show" />} />
    </div>
  );
}

// ---------------------------------------------------------------- reimbursable claims
function ClaimsDesk({ d }: { d: TaxDeskData }) {
  const cols: Column<ClaimRow>[] = [
    { key: "who", header: "Person", cell: (c) => <span className="flex flex-col"><span className="font-medium">{c.employee}</span><span className="text-sm text-text-muted">{c.component} · {new Date(c.claimMonth + "T00:00:00Z").toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" })}</span></span>, sortValue: (c) => c.employee },
    { key: "amount", header: "Claimed", align: "right", cell: (c) => <Money paise={c.amountPaise} />, sortValue: (c) => c.amountPaise },
    { key: "allowed", header: "Allowed", align: "right", cell: (c) => (c.allowedPaise != null ? <Money paise={c.allowedPaise} /> : "—"), hideBelow: "md" },
    { key: "status", header: "Status", cell: (c) => <span className="flex flex-col gap-1"><ClaimStatusBadge status={c.status} />{c.waitingOn && <span className="text-sm text-text-muted">with {c.waitingOn}</span>}{c.payrollMonth && <span className="text-sm text-text-muted">{new Date(c.payrollMonth + "T00:00:00Z").toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" })} payroll</span>}</span> },
    { key: "bills", header: "Bills", cell: (c) => <ul className="flex flex-wrap gap-2">{c.bills.map((b) => <li key={b.id}><a href={`/payroll/files/${b.id}`} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-sm text-accent-text underline-offset-4 hover:underline"><Paperclip aria-hidden className="size-3.5" />{b.name}</a></li>)}</ul>, hideBelow: "lg" },
  ];
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">Claims against reimbursable salary components, with bills. They&apos;re approved from the inbox (manager, then a payroll admin) and paid, tax-free up to the yearly limit, in the next open payroll.</p>
      <DataTable rows={d.claims} columns={cols} rowKey={(c) => c.id} caption={`Reimbursable claims for FY ${d.fyLabel}`} empty={<EmptyState compact icon={<Inbox />} title="No claims this year" />} />
    </div>
  );
}

// ---------------------------------------------------------------- returns
function Returns({ d }: { d: TaxDeskData }) {
  const link = (kind: string, q?: number) => `/payroll/tax/export/${kind}?fy=${d.fyLabel}${q ? `&q=${q}` : ""}`;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader title={`Form 24Q data for FY ${d.fyLabel}`} description="Quarterly TDS-on-salary return data in a TRACES-style column layout, for your return preparer. These are data exports, not the FVU file: challans, your TAN and the filing itself happen outside erp." />
        <CardBody className="flex flex-col gap-3">
          {!d.companyWide && <Banner tone="info">Only payroll admins for the whole company can export returns data.</Banner>}
          <div className="grid gap-3 sm:grid-cols-2">
            {QUARTERS.map((q) => (
              <div key={q.q} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
                <span className="min-w-0 flex-1 text-base font-medium">{q.label}</span>
                <Button size="sm" variant="secondary" asChild disabled={!d.companyWide}><a href={link("24q-annexure1", q.q)}><FileDown />Annexure I</a></Button>
                {q.q === 4 && <Button size="sm" variant="secondary" asChild disabled={!d.companyWide}><a href={link("24q-annexure2")}><FileDown />Annexure II</a></Button>}
              </div>
            ))}
          </div>
          <p className="text-sm text-text-muted">Annexure I lists tax deducted per person and month from finalised payroll; Annexure II (with Q4) carries each person&apos;s salary, exemptions, deductions and tax for the year on rates a CA has not verified.</p>
        </CardBody>
      </Card>
    </div>
  );
}
