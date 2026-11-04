"use client";
import * as React from "react";
import { ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/ui/button";
import { Field, Textarea } from "@/ui/field";
import { Checkbox } from "@/ui/choice";
import { Modal } from "@/ui/overlay";
import { Banner } from "@/ui/feedback";
import { deleteMyDataAction } from "@/app/p/privacy-actions";

/** Candidate portal: "Delete my data", with a confirmation step. After removal the portal link stops working. */
export function DeleteMyData({ token, company }: { token: string; company: string }) {
  const [open, setOpen] = React.useState(false);
  const [sure, setSure] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<{ outcome: string; message: string } | null>(null);
  const [busy, start] = React.useTransition();
  const go = () => start(async () => {
    setError(null);
    const r = await deleteMyDataAction(token, { confirm: sure, reason });
    if (!r.ok) { setError(r.error); return; }
    setResult(r.data); setOpen(false);
  });
  if (result) return <Banner tone={result.outcome === "removed" ? "success" : "info"} title={result.outcome === "removed" ? "Your details were removed" : "Request received"} className="mt-6">{result.message}</Banner>;
  return (
    <section aria-labelledby="privacy-h" className="mt-8 border-t border-border pt-4">
      <h2 id="privacy-h" className="flex items-center gap-1.5 text-base font-medium"><ShieldCheck aria-hidden className="size-4" />Your data</h2>
      <p className="mt-1 text-sm text-text-muted">{company} keeps your application details to run its hiring. You can ask for them to be deleted at any time.</p>
      <Button variant="link" className="mt-1" onClick={() => setOpen(true)}><Trash2 />Delete my data</Button>
      <Modal open={open} onOpenChange={setOpen} title="Delete your data?" description={`From ${company}'s hiring records`}
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Keep my data</Button><Button variant="danger" disabled={!sure} loading={busy} onClick={go}>Delete my data</Button></>}>
        <div className="flex flex-col gap-4">
          {error && <Banner tone="danger">{error}</Banner>}
          <p className="text-base">Your name, contact details, resume, documents and any letters are deleted, and your applications are withdrawn from view. This link and any others we sent you will stop working. This can&apos;t be undone.</p>
          <p className="text-sm text-text-muted">If there&apos;s an offer out for you, the hiring team finishes the request and emails you. If you&apos;ve already joined, your details are kept as employment records.</p>
          <Field label="Anything you'd like to tell us" help="Optional."><Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2} /></Field>
          <Checkbox checked={sure} onCheckedChange={(c) => setSure(c === true)} label="I understand my data will be deleted for good" />
        </div>
      </Modal>
    </section>
  );
}
