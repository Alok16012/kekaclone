"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, Ban, FilePen, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/ui/button";
import { Card, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { ConfirmDialog, Modal } from "@/ui/overlay";
import { Field, Input, Textarea } from "@/ui/field";
import { Segmented } from "@/ui/choice";
import { Banner, EmptyState, Skeleton } from "@/ui/feedback";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { toast } from "@/ui/toast";
import { cancelSignaturesAction, requestSignaturesAction, resendSignatureAction, signersAction } from "@/app/(app)/org/documents/actions";
import { MAX_SIGNERS, STATUS_LABEL, type SignerStatus } from "@/server/modules/documents/esign-rules";
import type { SignerRow } from "@/server/modules/documents/esign";

type Signer = { key: string; employeeId: string | null; email: string; name: string; title: string };
const TONE: Record<SignerStatus, "neutral" | "accent" | "success" | "danger"> = { waiting: "neutral", pending: "accent", signed: "success", declined: "danger" };

/** HR: ask people to sign a letter, in order. People in the company are picked by name; outside signers by email. */
export function RequestSignatures({ letterId, docType, personName, people, trigger, onDone }: { letterId: string; docType: string; personName: string; people: Person[]; trigger?: React.ReactNode; onDone?: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [signers, setSigners] = React.useState<Signer[]>([]);
  const [mode, setMode] = React.useState<"employee" | "outside">("employee");
  const [pick, setPick] = React.useState<string[]>([]);
  const [outside, setOutside] = React.useState({ email: "", name: "", title: "" });
  const [message, setMessage] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const add = () => {
    setError(null);
    if (mode === "employee") {
      const next = pick.filter((id) => !signers.some((s) => s.employeeId === id)).map((id) => { const p = people.find((x) => x.id === id)!; return { key: id, employeeId: id, email: "", name: p.name, title: p.title ?? "" }; });
      if (signers.length + next.length > MAX_SIGNERS) { setError(`At most ${MAX_SIGNERS} signers.`); return; }
      setSigners((s) => [...s, ...next]); setPick([]);
    } else {
      if (!outside.email.trim() || !outside.name.trim()) { setError("Outside signers need a name and an email address."); return; }
      if (signers.length >= MAX_SIGNERS) { setError(`At most ${MAX_SIGNERS} signers.`); return; }
      setSigners((s) => [...s, { key: outside.email.trim().toLowerCase(), employeeId: null, email: outside.email.trim(), name: outside.name.trim(), title: outside.title.trim() }]);
      setOutside({ email: "", name: "", title: "" });
    }
  };
  const move = (i: number, d: -1 | 1) => setSigners((s) => { const n = [...s]; const j = i + d; if (j < 0 || j >= n.length) return s; [n[i], n[j]] = [n[j], n[i]]; return n; });
  const send = () => start(async () => {
    const r = await requestSignaturesAction(letterId, signers.map((s) => ({ employeeId: s.employeeId, email: s.employeeId ? null : s.email, name: s.name, title: s.title || null })), message);
    if (!r.ok) { setError(r.error); return; }
    toast.success("Signature request sent", { description: `${signers[0].name} gets the first link by email.` });
    setOpen(false); setSigners([]); onDone?.();
  });
  return (
    <Modal open={open} onOpenChange={(o) => { setOpen(o); setError(null); }} size="lg" title={`Request signatures: ${docType}`}
      description={`Signers get an emailed link, confirm a one-time code, and sign by typing their name or drawing it. Each signature is stamped into the PDF with its audit trail. The letter is for ${personName}.`}
      trigger={trigger ?? <Button size="sm" variant="secondary"><FilePen />Request signatures</Button>}
      footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={pending} disabled={!signers.length} onClick={send}>Send to {signers.length || ""} {signers.length === 1 ? "signer" : "signers"}</Button></>}>
      <div className="flex flex-col gap-4">
        {error && <Banner tone="danger">{error}</Banner>}
        {signers.length > 0 && (
          <ol className="divide-y divide-border rounded-md border border-border" aria-label="Signers in order">
            {signers.map((s, i) => (
              <li key={s.key} className="flex items-center gap-2 px-3 py-2">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-pill bg-surface-hover text-sm tabular">{i + 1}</span>
                <div className="min-w-0 flex-1"><p className="truncate text-base font-medium">{s.name}</p><p className="truncate text-sm text-text-muted">{s.employeeId ? "In the company" : s.email}{s.title ? ` · ${s.title}` : ""}</p></div>
                <IconButton size="icon-sm" variant="ghost" label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp /></IconButton>
                <IconButton size="icon-sm" variant="ghost" label="Move down" disabled={i === signers.length - 1} onClick={() => move(i, 1)}><ArrowDown /></IconButton>
                <IconButton size="icon-sm" variant="ghost" label={`Remove ${s.name}`} onClick={() => setSigners((x) => x.filter((_, j) => j !== i))}><Trash2 /></IconButton>
              </li>
            ))}
          </ol>
        )}
        <div className="flex flex-col gap-3 rounded-md border border-dashed border-border p-3">
          <Segmented label="Signer type" value={mode} onChange={setMode} options={[{ value: "employee", label: "Someone here" }, { value: "outside", label: "Outside signer" }]} />
          {mode === "employee" ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <Field label="People" className="flex-1"><EmployeePicker multiple people={people} value={pick} onChange={setPick} /></Field>
              <Button type="button" variant="secondary" onClick={add} disabled={!pick.length}><Plus />Add</Button>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
              <Field label="Name"><Input value={outside.name} onChange={(e) => setOutside({ ...outside, name: e.target.value })} maxLength={120} /></Field>
              <Field label="Email"><Input type="email" value={outside.email} onChange={(e) => setOutside({ ...outside, email: e.target.value })} maxLength={200} /></Field>
              <Field label="Title" help="Optional"><Input value={outside.title} onChange={(e) => setOutside({ ...outside, title: e.target.value })} maxLength={80} placeholder="e.g. Director" /></Field>
              <Button type="button" variant="secondary" onClick={add}><Plus />Add</Button>
            </div>
          )}
        </div>
        <Field label="Note to signers" help="Optional, included in the email"><Textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} maxLength={500} /></Field>
      </div>
    </Modal>
  );
}

/** The signers of one letter with their status; HR can resend the current link or cancel the whole request. */
export function SignerList({ letterId, canManage, onChange }: { letterId: string; canManage: boolean; onChange?: () => void }) {
  const [rows, setRows] = React.useState<SignerRow[] | null>(null);
  const [pending, start] = React.useTransition();
  const [cancelling, setCancelling] = React.useState(false);
  const load = React.useCallback(() => signersAction(letterId).then((r) => setRows(r.ok ? r.data! : [])), [letterId]);
  React.useEffect(() => { load(); }, [load]);
  if (!rows) return <Skeleton className="h-12" />;
  if (!rows.length) return <p className="text-sm text-text-muted">No signatures were requested.</p>;
  const open = rows.some((r) => r.status === "waiting" || r.status === "pending");
  return (
    <div className="flex flex-col gap-2">
      <ol className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="tabular text-text-muted">{r.order}.</span>
            <span className="font-medium">{r.name}</span>{r.title && <span className="text-text-muted">· {r.title}</span>}
            <Badge tone={TONE[r.status]} size="sm">{STATUS_LABEL[r.status]}{r.status === "signed" && r.signed_at ? ` · ${new Date(r.signed_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })} (${r.method})` : ""}</Badge>
            {r.decline_reason && <span className="text-text-muted">{r.decline_reason}</span>}
            {canManage && r.status === "pending" && <Button size="sm" variant="ghost" loading={pending} onClick={() => start(async () => { const x = await resendSignatureAction(r.id); if (x.ok) toast.success("Link sent again"); else toast.error(x.error); })}><RefreshCw />Resend link</Button>}
          </li>
        ))}
      </ol>
      {canManage && open && (
        <div>
          <Button size="sm" variant="ghost" onClick={() => setCancelling(true)}><Ban />Cancel request</Button>
          {cancelling && <ConfirmDialog open onOpenChange={(o) => !o && setCancelling(false)} title="Cancel this signature request?" description="Links already sent stop working. Signatures already collected stay on the PDF." confirmLabel="Cancel request"
            onConfirm={async () => { const x = await cancelSignaturesAction(letterId); if (x.ok) { toast.success("Request cancelled"); load(); onChange?.(); } else toast.error(x.error); setCancelling(false); }} />}
        </div>
      )}
    </div>
  );
}

export type TrackingItem = { letter_id: string; doc_type: string; employee_id: string; employee: string; status: string; total: number; signed: number; pending_name: string | null; requested_at: string; requested_by: string | null };

/** /org/documents/sign: every letter with signatures requested. */
export function SignTracking({ rows }: { rows: TrackingItem[] }) {
  const [openId, setOpenId] = React.useState<string | null>(null);
  return (
    <Card>
      <CardHeader title="Signature requests" description="Letters sent through erp Sign, newest first. Open a person's Documents tab to send a new request." />
      {rows.length === 0 ? <EmptyState compact icon={<FilePen />} title="Nothing sent for signature yet" description="On a person's Documents tab, pick a letter and choose “Request signatures”." /> : (
        <ul className="divide-y divide-border border-t border-border">
          {rows.map((r) => (
            <li key={r.letter_id} className="px-5 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-base font-medium">{r.doc_type} · <Link href={`/people/${r.employee_id}?tab=documents`} className="hover:underline">{r.employee}</Link></p>
                  <p className="text-sm text-text-muted">Requested {new Date(r.requested_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}{r.requested_by ? ` by ${r.requested_by}` : ""} · {r.signed} of {r.total} signed{r.pending_name ? ` · waiting for ${r.pending_name}` : ""}</p>
                </div>
                <Badge tone={r.status === "signed" ? "success" : r.status === "pending_signature" ? "accent" : "neutral"}>{r.status === "signed" ? "Signed" : r.status === "pending_signature" ? "In progress" : "Not signed"}</Badge>
                <Button size="sm" variant="ghost" onClick={() => setOpenId(openId === r.letter_id ? null : r.letter_id)}>{openId === r.letter_id ? "Hide" : "Signers"}</Button>
              </div>
              {openId === r.letter_id && <div className="mt-2 rounded-md bg-surface-sunken p-3"><SignerList letterId={r.letter_id} canManage /></div>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
