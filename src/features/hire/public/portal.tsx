"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Download, FileUp, ShieldCheck, XCircle } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Field, Input, Textarea } from "@/ui/field";
import { Checkbox } from "@/ui/choice";
import { Modal } from "@/ui/overlay";
import { Banner } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import type { portalView } from "@/server/modules/hire/offers";
import { acceptOfferAction, declineOfferAction, requestCodeAction, taskAction, uploadDocAction } from "@/app/p/actions";
import { day, Html, inr0 } from "../shared";

type View = NonNullable<Awaited<ReturnType<typeof portalView>>>;
const DOC: Record<string, { tone: "neutral" | "warning" | "success" | "danger"; label: string }> = { requested: { tone: "neutral", label: "To upload" }, uploaded: { tone: "warning", label: "Being checked" }, approved: { tone: "success", label: "Approved" }, rejected: { tone: "danger", label: "Please upload again" } };

/** S43 / S147: the candidate's own page: read and sign (or decline) the offer, upload joining documents, tick off tasks. */
export function Portal({ token, view }: { token: string; view: View }) {
  const router = useRouter();
  const o = view.offer;
  const [name, setName] = React.useState("");
  const [code, setCode] = React.useState("");
  const [sentTo, setSentTo] = React.useState<string | null>(o?.codeSent ? view.maskedEmail : null);
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [declining, setDeclining] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [busy, start] = React.useTransition();
  const after = (msg: string) => { toast.success(msg); router.refresh(); };
  return (
    <div className="flex flex-col gap-5">
      <header>
        <p className="text-sm text-text-muted">{view.company}</p>
        <h1 className="mt-1 text-2xl font-semibold">Welcome, {view.firstName}</h1>
      </header>
      {o && (
        <Card>
          <CardHeader title={`Your offer: ${o.job}`} description={`${inr0(o.ctc_paise)} a year · joining ${day(o.joining_date)}${o.status === "released" && o.expires_on ? ` · please answer by ${day(o.expires_on)}` : ""}`}
            action={o.status === "accepted" ? <Badge tone="success"><CheckCircle2 aria-hidden />Accepted</Badge> : o.status === "declined" ? <Badge tone="danger"><XCircle aria-hidden />Declined</Badge> : o.status === "released" ? <Badge tone="accent">Waiting for you</Badge> : <Badge>No longer open</Badge>} />
          <CardBody className="flex flex-col gap-4">
            {o.html && <details open={o.status === "released"} className="rounded-md border border-border"><summary className="cursor-pointer px-4 py-2 font-medium">Read the letter</summary><div className="border-t border-border px-4 py-3"><Html html={o.html} /></div></details>}
            {o.hasLetter && <Button asChild variant="secondary" size="sm" className="self-start"><a href={`/p/portal/${token}/file/offer`} target="_blank" rel="noopener noreferrer"><Download />Download PDF<span className="sr-only"> (opens in a new tab)</span></a></Button>}
            {o.status === "accepted" && <p className="text-base">Signed by <strong>{o.signed_name}</strong>. A signed copy is in the PDF above.</p>}
            {o.status === "released" && (
              <div className="flex flex-col gap-4 rounded-md bg-surface-sunken p-4">
                <p className="flex items-center gap-2 font-medium"><ShieldCheck aria-hidden className="size-4" />Sign to accept</p>
                <p className="text-sm text-text-muted">Type your full name exactly as <strong>{view.name}</strong>, then enter the code we email to {view.maskedEmail}.</p>
                {error && !["typedName", "code"].includes(error.field ?? "") && <Banner tone="danger">{error.message}</Banner>}
                <Field label="Your full name" required error={error?.field === "typedName" ? error.message : undefined}><Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={120} /></Field>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <Field label="Code from the email" className="sm:w-48" error={error?.field === "code" ? error.message : undefined}><Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} /></Field>
                  <Button variant="secondary" loading={busy} onClick={() => start(async () => { setError(null); const r = await requestCodeAction(token); if (r.ok) { setSentTo(r.data!.sentTo); toast.success(`Code sent to ${r.data!.sentTo}`); } else setError({ message: r.error }); })}>{sentTo ? "Send a new code" : "Email me a code"}</Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button disabled={!name.trim() || code.length !== 6} loading={busy} onClick={() => start(async () => { setError(null); const r = await acceptOfferAction(token, name, code); if (r.ok) after("Offer accepted. Welcome aboard!"); else setError({ message: r.error, field: r.field }); })}>Accept and sign</Button>
                  <Button variant="ghost" onClick={() => setDeclining(true)}>Decline</Button>
                </div>
              </div>
            )}
          </CardBody>
        </Card>
      )}
      {view.docs.length > 0 && (
        <Card>
          <CardHeader title="Documents for joining" description="PDF, PNG or JPG, up to 5 MB each." />
          <ul className="divide-y divide-border border-t border-border">{view.docs.map((d) => <DocRow key={d.id} token={token} d={d} onDone={() => after(`${d.doc_type} uploaded`)} />)}</ul>
        </Card>
      )}
      {view.tasks.length > 0 && (
        <Card>
          <CardHeader title="Before you join" />
          <ul className="divide-y divide-border border-t border-border">
            {view.tasks.map((t) => (
              <li key={t.id} className="px-5 py-3">
                <Checkbox label={t.title} checked={t.done} onCheckedChange={(c) => start(async () => { const r = await taskAction(token, t.id, !!c); if (r.ok) router.refresh(); else toast.error(r.error); })} />
                {t.description && <p className="ml-6 text-sm text-text-muted">{t.description}</p>}
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Modal open={declining} onOpenChange={setDeclining} title="Decline the offer?" description="We'll let the hiring team know. This can't be undone."
        footer={<><Button variant="secondary" onClick={() => setDeclining(false)}>Keep it</Button><Button variant="danger" loading={busy} onClick={() => start(async () => { const r = await declineOfferAction(token, reason); if (r.ok) { setDeclining(false); after("We've let them know"); } else toast.error(r.error); })}>Decline offer</Button></>}>
        <Field label="Would you like to tell us why?" help="Optional"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></Field>
      </Modal>
    </div>
  );
}

function DocRow({ token, d, onDone }: { token: string; d: View["docs"][number]; onDone: () => void }) {
  const [busy, start] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const s = DOC[d.status] ?? DOC.requested;
  return (
    <li className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{d.doc_type}{!d.required && <span className="font-normal text-text-muted"> (optional)</span>}</p>
        {d.file_name && <a href={`/p/portal/${token}/file/${d.id}`} target="_blank" rel="noopener noreferrer" className="text-sm text-accent-text hover:underline">{d.file_name}<span className="sr-only"> (opens in a new tab)</span></a>}
        {d.status === "rejected" && d.reviewer_comment && <p className="text-sm text-danger-text">{d.reviewer_comment}</p>}
        {error && <p role="alert" className="text-sm text-danger-text">{error}</p>}
      </div>
      <Badge tone={s.tone}>{s.label}</Badge>
      {d.status !== "approved" && (
        <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border-strong px-3 py-1.5 text-sm font-medium hover:bg-surface-hover focus-within:ring-3 focus-within:ring-focus/25">
          <FileUp aria-hidden className="size-4" />{busy ? "Uploading…" : d.status === "requested" ? "Upload" : "Replace"}
          <input type="file" accept=".pdf,.png,.jpg,.jpeg" className="sr-only" aria-label={`Upload ${d.doc_type}`} disabled={busy} onChange={(e) => {
            const f = e.target.files?.[0]; if (!f) return;
            const fd = new FormData(); fd.set("requestId", d.id); fd.set("file", f);
            start(async () => { setError(null); const r = await uploadDocAction(token, fd); if (r.ok) onDone(); else setError(r.error); });
          }} />
        </label>
      )}
    </li>
  );
}
