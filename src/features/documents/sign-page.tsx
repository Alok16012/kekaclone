"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Eraser, FileText, MailCheck, PenLine, ShieldCheck, XCircle } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Field, Input, Textarea } from "@/ui/field";
import { Segmented } from "@/ui/choice";
import { Modal } from "@/ui/overlay";
import { Banner } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import type { SignView } from "@/server/modules/documents/esign";
import { STATUS_LABEL, shortHash } from "@/server/modules/documents/esign-rules";
import { declineSignAction, requestSignCodeAction, signAction } from "@/app/sign/actions";

const TONE = { waiting: "neutral", pending: "accent", signed: "success", declined: "danger" } as const;

/** erp Sign, the signer's page: read the document, get a code by email, sign by typing or drawing. */
export function SignPage({ token, view }: { token: string; view: SignView }) {
  const router = useRouter();
  const [sentTo, setSentTo] = React.useState<string | null>(view.codeSent ? view.signer.maskedEmail : null);
  const [method, setMethod] = React.useState<"typed" | "drawn">("typed");
  const [typedName, setTypedName] = React.useState("");
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [declining, setDeclining] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [busy, start] = React.useTransition();
  const pad = React.useRef<SignaturePadHandle>(null);
  const fe = (f: string) => (error?.field === f ? error.message : undefined);

  const sendCode = () => start(async () => {
    setError(null);
    const r = await requestSignCodeAction(token);
    if (!r.ok) { setError({ message: r.error }); return; }
    setSentTo(r.data!.sentTo); toast.success("Code sent", { description: `Check ${r.data!.sentTo}.` });
  });
  const sign = () => start(async () => {
    setError(null);
    const png = method === "drawn" ? pad.current?.toDataUrl() ?? null : null;
    if (method === "drawn" && !png) { setError({ message: "Draw your signature in the box first.", field: "png" }); return; }
    const r = await signAction(token, { code, method, typedName: method === "typed" ? typedName : null, png });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success("Signed", { description: r.data?.done ? "Everyone has signed. Thank you!" : "Thank you. The next signer has been emailed." });
    router.refresh();
  });

  return (
    <div className="flex flex-col gap-5">
      <header>
        <p className="flex items-center gap-1.5 text-sm text-text-muted"><ShieldCheck className="size-4" aria-hidden />{view.company} · erp Sign</p>
        <h1 className="mt-1 text-2xl font-semibold">{view.docType} for {view.employee}</h1>
        <p className="mt-1 text-base text-text-muted">Hello {view.signer.name}. You are signer {view.signer.order} of {view.signer.total}.</p>
      </header>

      <Card>
        <CardHeader title="The document" description="Read it in full before you sign. The fingerprint below is recorded with your signature." action={<Button asChild variant="secondary" size="sm"><a href={`/sign/${token}/file`} target="_blank" rel="noreferrer"><FileText />Open PDF</a></Button>} />
        <CardBody>
          <iframe src={`/sign/${token}/file`} title={`${view.docType} for ${view.employee}`} className="h-96 w-full rounded-md border border-border bg-surface" />
          <p className="mt-2 text-xs text-text-muted">Document fingerprint (SHA-256): <code className="font-mono">{shortHash(view.hash)}…</code></p>
        </CardBody>
      </Card>

      {view.status === "signed" && <Banner tone="success" title="You've signed this document">{view.signedAt ? `Signed on ${new Date(view.signedAt).toLocaleString("en-IN", { dateStyle: "long", timeStyle: "short" })}.` : ""} {view.letterStatus === "signed" ? "Everyone has signed." : "The next signer has been notified."}</Banner>}
      {view.status === "declined" && <Banner tone="warning" title="You declined to sign">{view.declineReason ?? ""}</Banner>}
      {view.status === "waiting" && <Banner tone="info" title="It isn't your turn yet">We&apos;ll email you when the signer before you has finished.</Banner>}

      {view.status === "pending" && (
        <Card>
          <CardHeader title="Sign" description="Step 1: get a one-time code by email. Step 2: sign by typing your name or drawing it." />
          <CardBody className="flex flex-col gap-4">
            {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
            {!sentTo ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button onClick={sendCode} loading={busy}><MailCheck />Email me a code</Button>
                <span className="text-sm text-text-muted">We&apos;ll send it to {view.signer.maskedEmail}.</span>
              </div>
            ) : (
              <div className="flex items-start gap-3 rounded-md bg-accent-soft px-4 py-3 text-accent-text" role="status">
                <MailCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
                <p className="text-base">We emailed a 6-digit code to <strong>{sentTo}</strong>. It works for 10 minutes. <button type="button" className="font-medium underline" onClick={sendCode} disabled={busy}>Send a new one</button></p>
              </div>
            )}
            <Segmented label="How to sign" value={method} onChange={setMethod} options={[{ value: "typed", label: "Type my name" }, { value: "drawn", label: "Draw my signature" }]} />
            {method === "typed" ? (
              <Field label="Your full name" required help={`Type it exactly as shown: ${view.signer.name}`} error={fe("typedName")}>
                <Input value={typedName} onChange={(e) => setTypedName(e.target.value)} autoComplete="name" maxLength={120} className="text-lg italic" />
              </Field>
            ) : (
              <Field label="Draw your signature" required help="Use your mouse, finger or stylus." error={fe("png")}>
                <SignaturePad ref={pad} />
              </Field>
            )}
            <Field label="Code from email" required error={fe("code")}>
              <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={7} className="max-w-48 text-lg tracking-[0.4em] tabular" />
            </Field>
            <p className="text-sm text-text-muted">By signing you agree that your electronic signature, the time, your network address and the document fingerprint are recorded on the PDF.</p>
            <div className="flex flex-wrap gap-2">
              <Button size="lg" onClick={sign} loading={busy} disabled={!sentTo}><PenLine />Sign the document</Button>
              <Button size="lg" variant="ghost" onClick={() => setDeclining(true)} disabled={busy}><XCircle />Decline</Button>
            </div>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="Signers" />
        <ol className="divide-y divide-border border-t border-border">
          {view.others.map((s) => (
            <li key={s.order} className="flex items-center gap-3 px-5 py-2.5">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-pill bg-surface-hover text-sm tabular">{s.order}</span>
              <span className="flex-1 text-base">{s.name}{s.order === view.signer.order ? " (you)" : ""}</span>
              <Badge tone={TONE[s.status]}>{s.status === "signed" ? <CheckCircle2 /> : null}{STATUS_LABEL[s.status]}</Badge>
            </li>
          ))}
        </ol>
      </Card>

      {declining && (
        <Modal open onOpenChange={(o) => !o && setDeclining(false)} size="sm" title="Decline to sign?" description="The sender is told, and the signing stops here for everyone after you."
          footer={<><Button variant="secondary" onClick={() => setDeclining(false)}>Back</Button><Button variant="danger" loading={busy} onClick={() => start(async () => { const r = await declineSignAction(token, reason); if (!r.ok) toast.error(r.error); else { toast.success("Declined"); setDeclining(false); router.refresh(); } })}>Decline</Button></>}>
          <Field label="Reason" help="Optional, shared with the sender"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} /></Field>
        </Modal>
      )}
    </div>
  );
}

type SignaturePadHandle = { toDataUrl: () => string | null; clear: () => void };

/** A plain canvas: pointer events draw a stroke; the PNG is produced from the canvas pixels. */
const SignaturePad = React.forwardRef<SignaturePadHandle>(function SignaturePad(_, ref) {
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const drawing = React.useRef(false);
  const [dirty, setDirty] = React.useState(false);
  const ctx = () => canvas.current?.getContext("2d") ?? null;
  const pos = (e: React.PointerEvent) => { const r = canvas.current!.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * canvas.current!.width, y: ((e.clientY - r.top) / r.height) * canvas.current!.height }; };
  const clear = () => { const c = ctx(); if (!c || !canvas.current) return; c.clearRect(0, 0, canvas.current.width, canvas.current.height); setDirty(false); };
  React.useImperativeHandle(ref, () => ({ toDataUrl: () => (dirty && canvas.current ? canvas.current.toDataURL("image/png") : null), clear: () => { const c = ctx(); if (!c || !canvas.current) return; c.clearRect(0, 0, canvas.current.width, canvas.current.height); setDirty(false); } }), [dirty]);
  return (
    <div className="flex flex-col gap-2">
      <canvas ref={canvas} width={600} height={200} role="img" aria-label="Signature drawing area" tabIndex={0}
        className="h-40 w-full touch-none rounded-md border border-border-input bg-surface"
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drawing.current = true; const c = ctx(); if (!c) return; const p = pos(e); c.lineWidth = 2.5; c.lineCap = "round"; c.lineJoin = "round"; c.strokeStyle = "#14171c"; c.beginPath(); c.moveTo(p.x, p.y); }}
        onPointerMove={(e) => { if (!drawing.current) return; const c = ctx(); if (!c) return; const p = pos(e); c.lineTo(p.x, p.y); c.stroke(); setDirty(true); }}
        onPointerUp={() => { drawing.current = false; }} onPointerLeave={() => { drawing.current = false; }} />
      <div><Button type="button" size="sm" variant="ghost" onClick={clear}><Eraser />Clear</Button></div>
    </div>
  );
});
