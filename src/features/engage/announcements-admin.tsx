"use client";
import * as React from "react";
import { CalendarClock, Ellipsis, Megaphone, Pin, PinOff, Send, Trash } from "lucide-react";
import { Badge, StatusChip } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { DataTable, type Column } from "@/ui/table";
import { EmptyState } from "@/ui/feedback";
import { Field, Input } from "@/ui/field";
import { ConfirmDialog, Menu, Modal } from "@/ui/overlay";
import { toast } from "@/ui/toast";
import type { Person } from "@/ui/employee-picker";
import { useToday } from "@/lib/use-today";
import type { AnnouncementRow, ComposerOptions } from "@/server/modules/engage/service";
import { deletePostAction, pinAction, rescheduleAction } from "@/app/(app)/engage/actions";
import { Composer } from "./composer";
import { fmtDateTime } from "./use-now";

const STATUS = { scheduled: { status: "pending", label: "Scheduled" }, live: { status: "live", label: "Live" }, expired: { status: "cancelled", label: "Expired" } } as const;
const isoLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const localInput = (iso: string) => { const d = new Date(iso); return `${isoLocal(d)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

type Dialog = { kind: "pin" | "schedule" | "delete"; row: AnnouncementRow } | null;

/** HR list of announcements: status, audience, pin / schedule / publish now / delete. */
export function AnnouncementsAdmin({ rows, options, people }: { rows: AnnouncementRow[]; options: ComposerOptions; people: Person[] }) {
  const [dialog, setDialog] = React.useState<Dialog>(null);
  const [composing, setComposing] = React.useState(false);
  const [value, setValue] = React.useState("");
  const [busy, start] = React.useTransition();
  const today = useToday();

  const run = (p: Promise<{ ok: boolean; error?: string }>, done: string) => start(async () => {
    const r = await p;
    if (!r.ok) { toast.error(r.error ?? "Something went wrong."); return; }
    toast.success(done);
    setDialog(null);
  });

  const columns: Column<AnnouncementRow>[] = [
    {
      key: "title", header: "Announcement", sortValue: (r) => r.title.toLowerCase(),
      cell: (r) => (
        <div className="min-w-0 max-w-[15rem] sm:max-w-xs lg:max-w-md">
          <p className="flex flex-wrap items-center gap-1.5 font-medium">{r.title}{r.pinned && <Badge tone="accent"><Pin aria-hidden />Pinned</Badge>}</p>
          <p className="truncate text-sm text-text-muted">{r.body}</p>
          <p className="mt-0.5 text-sm text-text-muted md:hidden">{r.audience} · {fmtDateTime(r.publishAt)}</p>
          <span className="mt-1 inline-flex md:hidden"><StatusChip status={STATUS[r.status].status} label={STATUS[r.status].label} /></span>
        </div>
      ),
    },
    { key: "status", header: "Status", hideBelow: "md", sortValue: (r) => r.status, cell: (r) => <StatusChip status={STATUS[r.status].status} label={STATUS[r.status].label} /> },
    { key: "audience", header: "Audience", hideBelow: "md", cell: (r) => <span className="text-sm">{r.audience}</span> },
    { key: "when", header: "Publish time", hideBelow: "md", sortValue: (r) => r.publishAt, cell: (r) => <span className="text-sm tabular">{fmtDateTime(r.publishAt)}</span> },
    { key: "by", header: "By", hideBelow: "lg", sortValue: (r) => r.author, cell: (r) => <span className="text-sm">{r.author}</span> },
    { key: "engagement", header: "Reactions · comments", hideBelow: "lg", align: "right", cell: (r) => <span className="text-sm tabular">{r.reactions} · {r.comments}</span> },
    {
      key: "actions", header: <span className="sr-only">Actions</span>, align: "right",
      cell: (r) => r.canManage ? (
        <Menu trigger={<IconButton label={`Actions for ${r.title}`} size="icon-sm"><Ellipsis /></IconButton>} items={[
          r.pinned
            ? { label: "Unpin", icon: <PinOff />, onSelect: () => run(pinAction(r.id, null), "Unpinned") }
            : { label: "Pin to top…", icon: <Pin />, disabled: r.status !== "live" && r.status !== "scheduled", onSelect: () => { setValue(""); setDialog({ kind: "pin", row: r }); } },
          ...(r.status === "scheduled" ? [
            { label: "Change schedule…", icon: <CalendarClock />, onSelect: () => { setValue(localInput(r.publishAt)); setDialog({ kind: "schedule", row: r }); } },
            { label: "Publish now", icon: <Send />, onSelect: () => run(rescheduleAction(r.id, null), "Published and sent") },
          ] : []),
          "separator",
          { label: "Delete", icon: <Trash />, danger: true, onSelect: () => setDialog({ kind: "delete", row: r }) },
        ]} />
      ) : null,
    },
  ];

  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button onClick={() => setComposing(true)}><Megaphone />New announcement</Button>
      </div>
      <DataTable caption="Announcements" rows={rows} columns={columns} rowKey={(r) => r.id}
        empty={<EmptyState icon={<Megaphone />} title="No announcements yet" description="Announcements reach everyone you choose and can be pinned to the top of Home." action={<Button onClick={() => setComposing(true)}>Write one</Button>} />} />

      <Modal open={dialog?.kind === "pin"} onOpenChange={(o) => !o && setDialog(null)} size="sm" title="Pin to the top of Home" description="It stays above the feed until the end of the day you pick."
        footer={<><Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button><Button loading={busy} disabled={!value} onClick={() => dialog && run(pinAction(dialog.row.id, value), "Pinned")}>Pin</Button></>}>
        <Field label="Pin until" required><Input type="date" value={value} min={today ? isoLocal(today) : undefined} onChange={(e) => setValue(e.target.value)} /></Field>
      </Modal>

      <Modal open={dialog?.kind === "schedule"} onOpenChange={(o) => !o && setDialog(null)} size="sm" title="Change the publish time" description="People are notified when it goes live."
        footer={<><Button variant="secondary" onClick={() => setDialog(null)}>Cancel</Button><Button loading={busy} disabled={!value} onClick={() => dialog && run(rescheduleAction(dialog.row.id, new Date(value).toISOString()), "Schedule updated")}>Save</Button></>}>
        <Field label="Publish on" required><Input type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} /></Field>
      </Modal>

      <ConfirmDialog open={dialog?.kind === "delete"} onOpenChange={(o) => !o && setDialog(null)} title="Delete this announcement?"
        description={dialog?.kind === "delete" ? `"${dialog.row.title}" and its comments are removed for everyone.` : ""} confirmLabel="Delete"
        onConfirm={async () => { if (dialog) { const r = await deletePostAction(dialog.row.id, { refresh: true }); if (r.ok) toast.success("Announcement deleted"); else toast.error(r.error); } }} />

      {composing && (
        <Composer open onOpenChange={(o) => !o && setComposing(false)} initialKind="announcement" options={options} people={people}
          onCreated={(item, at) => toast.success(item ? "Announcement published" : `Scheduled for ${fmtDateTime(at!)}`)} />
      )}
    </>
  );
}
