"use client";
import * as React from "react";
import { ArrowDown, ArrowUp, ExternalLink, Link2, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { Card, CardHeader } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Field, Input } from "@/ui/field";
import { ConfirmDialog, Menu, Modal } from "@/ui/overlay";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { deleteQuickLinkAction, moveQuickLinkAction, saveQuickLinkAction } from "@/app/(app)/settings/quick-links/actions";
import { MAX_QUICK_LINKS, hostOf } from "@/server/modules/home/rules";

type Link = { id: string; label: string; url: string };

/** Up to 18 links everyone sees on Home: the intranet, the travel desk, the benefits portal. */
export function QuickLinksAdmin({ links, canEdit }: { links: Link[]; canEdit: boolean }) {
  const [editing, setEditing] = React.useState<Link | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<Link | null>(null);
  const [pending, start] = React.useTransition();
  const full = links.length >= MAX_QUICK_LINKS;
  const move = (id: string, dir: "up" | "down") => start(async () => { const r = await moveQuickLinkAction(id, dir); if (!r.ok) toast.error(r.error); });
  return (
    <Card>
      <CardHeader title="Quick links" description={`Shown on everyone's Home, in this order. ${links.length} of ${MAX_QUICK_LINKS} used.`}
        action={canEdit ? <Button size="sm" onClick={() => setEditing("new")} disabled={full}><Plus />Add link</Button> : undefined} />
      {!canEdit && <div className="px-5 pb-4"><Banner tone="info">Only admins who can edit company settings can change quick links.</Banner></div>}
      {canEdit && full && <div className="px-5 pb-4"><Banner tone="warning">You&apos;ve reached {MAX_QUICK_LINKS} links. Remove one to add another.</Banner></div>}
      {links.length === 0 ? <EmptyState compact icon={<Link2 />} title="No quick links yet" description={canEdit ? "Add the sites people open every day." : undefined} /> : (
        <ul className="divide-y divide-border border-t border-border" aria-busy={pending || undefined}>
          {links.map((l, i) => (
            <li key={l.id} className="flex items-center gap-3 px-5 py-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-text" aria-hidden><Link2 className="size-4" /></span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-medium">{l.label}</p>
                <a href={l.url} target="_blank" rel="noopener noreferrer" className="inline-flex max-w-full items-center gap-1 truncate text-sm text-text-muted hover:underline">{hostOf(l.url)}<ExternalLink className="size-3" aria-hidden /></a>
              </div>
              {canEdit && (
                <Menu trigger={<IconButton size="icon-sm" label={`Actions for ${l.label}`}><MoreHorizontal /></IconButton>}
                  items={[
                    { label: "Edit", icon: <Pencil />, onSelect: () => setEditing(l) },
                    { label: "Move up", icon: <ArrowUp />, disabled: i === 0, onSelect: () => move(l.id, "up") },
                    { label: "Move down", icon: <ArrowDown />, disabled: i === links.length - 1, onSelect: () => move(l.id, "down") },
                    "separator", { label: "Remove", icon: <Trash2 />, danger: true, onSelect: () => setDeleting(l) },
                  ]} />
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <LinkDialog link={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)} title={`Remove “${deleting.label}”?`} description="It disappears from everyone's Home." confirmLabel="Remove"
        onConfirm={async () => { const r = await deleteQuickLinkAction(deleting.id); if (r.ok) toast.success("Link removed"); else toast.error(r.error); setDeleting(null); }} />}
    </Card>
  );
}

function LinkDialog({ link, onClose }: { link: Link | null; onClose: () => void }) {
  const [label, setLabel] = React.useState(link?.label ?? "");
  const [url, setUrl] = React.useState(link?.url ?? "");
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    const r = await saveQuickLinkAction(link?.id ?? null, { label, url });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success(link ? "Link updated" : "Link added"); onClose();
  });
  const err = (f: string) => (error?.field === f ? error.message : undefined);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="sm" title={link ? "Edit link" : "Add link"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>Save</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <Field label="Name" required error={err("label")}><Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} autoFocus placeholder="e.g. Travel desk" /></Field>
        <Field label="Web address" required error={err("url")}><Input value={url} onChange={(e) => setUrl(e.target.value)} type="url" inputMode="url" placeholder="https://" maxLength={2000} /></Field>
      </form>
    </Modal>
  );
}
