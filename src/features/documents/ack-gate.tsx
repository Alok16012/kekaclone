"use client";
import * as React from "react";
import { Dialog as D } from "radix-ui";
import { CheckCircle2, ExternalLink, FileText, Lock } from "lucide-react";
import { Button } from "@/ui/button";
import { Checkbox } from "@/ui/choice";
import { Banner } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { acknowledgeDocumentAction } from "@/app/(app)/org/documents/actions";
import { logoutAction } from "@/app/(auth)/actions";

export type GateDoc = { id: string; title: string; description: string | null; file_id: string; file_name: string; folder: string };

/**
 * S49: a blocking interstitial. It can't be dismissed (no close button, Esc and outside clicks do nothing) and the page
 * underneath is inert, until every blocking document is acknowledged. Signing out is always possible.
 */
export function AckInterstitial({ docs }: { docs: GateDoc[] }) {
  const [opened, setOpened] = React.useState<Set<string>>(new Set());
  const [checked, setChecked] = React.useState<Set<string>>(new Set());
  const [done, setDone] = React.useState<Set<string>>(new Set());
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const left = docs.filter((d) => !done.has(d.id));
  if (left.length === 0) return null;
  const doc = left[0];
  const acknowledge = () => start(async () => {
    setError(null);
    const r = await acknowledgeDocumentAction(doc.id);
    if (!r.ok) { setError(r.error); return; }
    setDone((s) => new Set(s).add(doc.id));
    toast.success("Thanks for acknowledging", { description: doc.title });
  });
  return (
    <D.Root open modal>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-70 bg-overlay/60 backdrop-blur-sm" />
        <D.Content onEscapeKeyDown={(e) => e.preventDefault()} onPointerDownOutside={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()}
          className="fixed inset-0 z-70 flex flex-col bg-surface shadow-modal focus:outline-none sm:inset-auto sm:left-1/2 sm:top-1/2 sm:max-h-[85vh] sm:w-full sm:max-w-(--size-modal-md) sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg">
          <div className="flex items-start gap-3 border-b border-border px-5 py-4">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-pill bg-warning-soft text-warning-text" aria-hidden><Lock className="size-4" /></span>
            <div>
              <D.Title className="text-lg font-semibold">Please read before you continue</D.Title>
              <D.Description className="mt-0.5 text-sm text-text-muted">
                Your company needs you to acknowledge {docs.length === 1 ? "this document" : `${docs.length} documents`} before using erp.{docs.length > 1 ? ` ${docs.length - left.length + 1} of ${docs.length}.` : ""}
              </D.Description>
            </div>
          </div>
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
            {error && <Banner tone="danger">{error}</Banner>}
            <div className="flex items-start gap-3 rounded-md border border-border p-4">
              <FileText className="mt-0.5 size-5 shrink-0 text-text-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-base font-semibold">{doc.title}</p>
                <p className="text-sm text-text-muted">{doc.folder} · {doc.file_name}</p>
                {doc.description && <p className="mt-2 text-base">{doc.description}</p>}
                <Button asChild variant="secondary" size="sm" className="mt-3">
                  <a href={`/files/${doc.file_id}`} target="_blank" rel="noreferrer" onClick={() => setOpened((s) => new Set(s).add(doc.id))}><ExternalLink />Open document</a>
                </Button>
              </div>
            </div>
            <Checkbox label="I have read and understood this document" disabled={!opened.has(doc.id)} checked={checked.has(doc.id)}
              onCheckedChange={(c) => setChecked((s) => { const n = new Set(s); if (c) n.add(doc.id); else n.delete(doc.id); return n; })} />
            {!opened.has(doc.id) && <p className="text-sm text-text-muted">Open the document first. It opens in a new tab.</p>}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3">
            <Button variant="ghost" onClick={() => { void logoutAction().then((r) => window.location.assign(r.redirectTo)); }}>Sign out</Button>
            <Button loading={pending} disabled={!checked.has(doc.id)} onClick={acknowledge}><CheckCircle2 />Acknowledge</Button>
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
