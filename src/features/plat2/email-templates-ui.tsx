"use client";
import * as React from "react";
import Link from "next/link";
import { Eye, Mail, RotateCcw } from "lucide-react";
import { Button } from "@/ui/button";
import { Card, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Field, Input, Textarea } from "@/ui/field";
import { Banner } from "@/ui/feedback";
import { Drawer } from "@/ui/overlay";
import { toast } from "@/ui/toast";
import { TEMPLATE_PLACEHOLDERS } from "@/server/modules/notifications/templates";
import type { TemplateRow } from "@/server/modules/notifications/service";
import { previewEmailTemplateAction, resetEmailTemplateAction, saveEmailTemplateAction } from "@/app/(app)/settings/notifications/templates/actions";

/** Settings → Notifications → Email templates: per event subject + text with placeholders, preview, reset to default. */
export function EmailTemplatesPage({ groups, canEdit }: { groups: { group: string; templates: TemplateRow[] }[]; canEdit: boolean }) {
  const [open, setOpen] = React.useState<TemplateRow | null>(null);
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Email templates</h2>
        <p className="text-base text-text-muted">The subject and text of each event&apos;s email. Which events are emailed at all is set under <Link href="/settings/notifications" className="text-accent-text hover:underline">Events &amp; emails</Link>.</p>
      </div>
      {!canEdit && <p className="text-sm text-text-muted">Only people who can change notification settings can edit these.</p>}
      {groups.map((g) => (
        <Card key={g.group}>
          <CardHeader title={g.group} />
          <ul className="divide-y divide-border border-t border-border">
            {g.templates.map((t) => (
              <li key={t.key} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:gap-4">
                <span className="min-w-0 flex-1">
                  <span className="block text-base">{t.label}</span>
                  <span className="block truncate text-sm text-text-muted">Subject: {t.subject}</span>
                </span>
                <span className="flex items-center gap-2">
                  {t.isDefault ? <Badge tone="neutral">Default</Badge> : <Badge tone="accent">Customised</Badge>}
                  <Button size="sm" variant="secondary" onClick={() => setOpen(t)}><Mail />{canEdit ? "Edit" : "View"}</Button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
      <TemplateDrawer t={open} canEdit={canEdit} onClose={() => setOpen(null)} />
    </div>
  );
}

function TemplateDrawer({ t, canEdit, onClose }: { t: TemplateRow | null; canEdit: boolean; onClose: () => void }) {
  const [subject, setSubject] = React.useState("");
  const [body, setBody] = React.useState("");
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [preview, setPreview] = React.useState<{ subject: string; paragraphs: string[] } | null>(null);
  const [pending, start] = React.useTransition();
  const [seen, setSeen] = React.useState(t);
  if (t !== seen) { setSeen(t); if (t) { setSubject(t.subject); setBody(t.body); setError(null); setPreview(null); } }
  const insert = (k: string) => setBody((b) => `${b}${b.endsWith("\n") || !b ? "" : " "}{{${k}}}`);
  return (
    <Drawer open={!!t} onOpenChange={(o) => !o && onClose()} title={t?.label ?? ""} description="Blank lines separate paragraphs. The email always ends with an 'Open in erp' button."
      footer={<div className="flex w-full items-center justify-between gap-2">
        {canEdit && t && !t.isDefault ? <Button variant="ghost" size="sm" loading={pending} onClick={() => start(async () => { const r = await resetEmailTemplateAction(t.key); if (r.ok) { toast.success("Back to the default template"); onClose(); } else toast.error(r.error); })}><RotateCcw />Reset to default</Button> : <span />}
        <span className="flex gap-2">
          <Button variant="secondary" loading={pending} onClick={() => start(async () => { setError(null); const r = await previewEmailTemplateAction({ subject, body }); if (r.ok) setPreview(r.data!); else setError({ message: r.error, field: r.field }); })}><Eye />Preview</Button>
          {canEdit && <Button loading={pending} onClick={() => start(async () => { setError(null); const r = await saveEmailTemplateAction(t!.key, { subject, body }); if (r.ok) { toast.success("Template saved"); onClose(); } else setError({ message: r.error, field: r.field }); })}>Save</Button>}
        </span>
      </div>}>
      <div className="flex flex-col gap-4">
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <Field label="Subject" error={error?.field === "subject" ? error.message : undefined}><Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} disabled={!canEdit} /></Field>
        <Field label="Text" error={error?.field === "body" ? error.message : undefined}><Textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} disabled={!canEdit} /></Field>
        <div>
          <p className="mb-1 text-sm font-medium">Placeholders</p>
          <div className="flex flex-wrap gap-1.5">{TEMPLATE_PLACEHOLDERS.map((p) => <button key={p.key} type="button" disabled={!canEdit} title={p.label} onClick={() => insert(p.key)} className="rounded-sm border border-border bg-surface-sunken px-1.5 py-0.5 font-mono text-xs hover:border-border-strong disabled:opacity-60">{`{{${p.key}}}`}</button>)}</div>
        </div>
        {preview && (
          <div className="rounded-md border border-border bg-surface-sunken p-4" aria-live="polite">
            <p className="text-xs uppercase tracking-wide text-text-muted">Preview with sample values</p>
            <p className="mt-1 text-base font-semibold">{preview.subject}</p>
            {preview.paragraphs.map((p, i) => <p key={i} className="mt-2 text-base">{p}</p>)}
          </div>
        )}
      </div>
    </Drawer>
  );
}
