"use client";
import * as React from "react";
import { FileText, Paperclip, Upload, X } from "lucide-react";
import { Card, CardHeader } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { removeProofAction, uploadProofAction } from "@/app/(app)/me/tax/actions";
import { SECTION_LABEL, type Section } from "@/server/modules/tax/rules";
import type { MyTax, TaxItemView } from "@/server/modules/tax/service";
import { Money, ProofStatus } from "./shared";

export function ProofsTab({ d }: { d: MyTax }) {
  const items = d.items;
  return (
    <div className="flex flex-col gap-4">
      <Banner tone={d.proofWindow.open ? "info" : "warning"} title={d.proofWindow.open ? "Proof submission is open" : "Proof submission is closed"}>
        {d.proofWindow.message} Send a receipt, statement or certificate for each item (PDF, PNG or JPG, up to 5 MB each). Once a proof is checked, payroll uses the accepted amount.
      </Banner>
      {items.length === 0 ? (
        <Card><EmptyState icon={<FileText />} title="Nothing to prove yet" description="Declare investments, rent or a home loan first; each one gets a place for its proof here." /></Card>
      ) : (
        <Card>
          <CardHeader title="Your proofs" description={`${items.filter((i) => i.proofStatus === "accepted" || i.proofStatus === "partially_accepted").length} of ${items.length} checked`} />
          <ul className="divide-y divide-border border-t border-border">
            {items.map((i) => <ProofRow key={i.id} item={i} open={d.proofWindow.open} />)}
          </ul>
        </Card>
      )}
    </div>
  );
}

function ProofRow({ item: i, open }: { item: TaxItemView; open: boolean }) {
  const input = React.useRef<HTMLInputElement>(null);
  const [pending, start] = React.useTransition();
  const upload = (files: FileList | null) => {
    if (!files?.length) return;
    const form = new FormData();
    form.set("itemId", i.id);
    for (const f of Array.from(files)) form.append("files", f);
    start(async () => {
      const r = await uploadProofAction(form);
      if (r.ok) toast.success("Proof sent for checking"); else toast.error(r.error);
      if (input.current) input.current.value = "";
    });
  };
  const canChange = open && !i.locked;
  return (
    <li className="flex flex-col gap-3 px-5 py-4 md:flex-row md:items-start md:gap-6">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-base font-medium"><span>{i.label}</span><ProofStatus status={i.proofStatus} /></p>
        <p className="text-sm text-text-muted">{SECTION_LABEL[i.section as Section] ?? i.section} · Declared <Money paise={i.declaredPaise} />
          {i.acceptedPaise != null && (i.proofStatus === "accepted" || i.proofStatus === "partially_accepted") ? <> · Accepted <Money paise={i.acceptedPaise} /></> : null}</p>
        {i.comment && <p className="mt-1 rounded-md bg-surface-sunken px-3 py-2 text-sm">Payroll: {i.comment}</p>}
        {i.proofs.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-2">
            {i.proofs.map((f) => (
              <li key={f.id} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-sm">
                <Paperclip aria-hidden className="size-3.5 text-text-muted" />
                <a href={`/tax/files/${f.id}`} target="_blank" rel="noopener" className="max-w-48 truncate text-accent-text underline-offset-4 hover:underline">{f.name}</a>
                {canChange && <IconButton label={`Remove ${f.name}`} variant="ghost" size="icon-sm" disabled={pending} onClick={() => start(async () => { const r = await removeProofAction(i.id, f.id); if (!r.ok) toast.error(r.error); })}><X /></IconButton>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {canChange && (
        <div className="shrink-0">
          <input ref={input} type="file" multiple accept=".pdf,.png,.jpg,.jpeg" className="sr-only" id={`proof-${i.id}`} onChange={(e) => upload(e.target.files)} />
          <Button variant="secondary" size="sm" loading={pending} onClick={() => input.current?.click()}><Upload />{i.proofs.length ? "Add more" : "Upload proof"}</Button>
        </div>
      )}
    </li>
  );
}
