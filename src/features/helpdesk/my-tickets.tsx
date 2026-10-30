"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Headset, LifeBuoy, MessageSquare, Paperclip, Plus } from "lucide-react";
import { Card } from "@/ui/card";
import { Button } from "@/ui/button";
import { Modal } from "@/ui/overlay";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { EmptyState } from "@/ui/feedback";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { PageHeader } from "@/ui/app-shell";
import { toast } from "@/ui/toast";
import { raiseTicketAction } from "@/app/(app)/helpdesk/actions";
import { ACCEPT, ACCEPT_LABEL, MAX_UPLOAD_BYTES } from "@/server/modules/documents/rules";
import { formatMinutes, MAX_ATTACHMENTS } from "@/server/modules/helpdesk/rules";
import type { CategoryOption, TicketRowDTO } from "./types";
import { TicketDrawer } from "./ticket-drawer";
import { SlaFlag, TicketStatusBadge } from "./bits";

/** The employee's helpdesk: raise a ticket, follow its status and conversation. */
export function MyTickets({ tickets, categories, isAgent, initialTicket, startNew }: { tickets: TicketRowDTO[]; categories: CategoryOption[]; isAgent: boolean; initialTicket: string | null; startNew: boolean }) {
  const [open, setOpen] = React.useState<string | null>(initialTicket);
  const [raising, setRaising] = React.useState(startNew);
  const [tab, setTab] = React.useState("active");
  const router = useRouter();
  const active = tickets.filter((t) => t.status !== "closed");
  const closed = tickets.filter((t) => t.status === "closed");
  const close = () => {
    setOpen(null);
    if (initialTicket || startNew) router.replace("/me/helpdesk", { scroll: false });
  };
  const list = (rows: TicketRowDTO[], empty: React.ReactNode) => rows.length === 0 ? empty : (
    <Card>
      <ul className="divide-y divide-border">
        {rows.map((t) => (
          <li key={t.id}>
            <button type="button" onClick={() => setOpen(t.id)} className="flex w-full flex-col gap-1.5 px-5 py-3.5 text-left hover:bg-surface-sunken sm:flex-row sm:items-center sm:gap-4">
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2"><span className="text-sm tabular text-text-muted">{t.ref}</span><span className="truncate text-base font-medium">{t.title}</span></span>
                <span className="block text-sm text-text-muted">{t.category} · {t.assignee ? `with ${t.assignee}` : "waiting for an agent"} · updated {t.ago}</span>
              </span>
              <span className="flex shrink-0 flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 text-sm text-text-muted" aria-label={`${t.messages} messages`}><MessageSquare className="size-3.5" aria-hidden />{t.messages}</span>
                <SlaFlag sla={t.sla} closed={t.status === "closed"} />
                <TicketStatusBadge status={t.status} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
  return (
    <>
      <PageHeader title="Helpdesk" description="Ask HR, IT or finance for help and follow the answer here."
        actions={<div className="flex flex-wrap gap-2">
          {isAgent && <Button asChild variant="secondary"><Link href="/helpdesk"><Headset />Agent queue</Link></Button>}
          <Button onClick={() => setRaising(true)} disabled={!categories.length}><Plus />New ticket</Button>
        </div>} />
      {tickets.length === 0 ? (
        <Card><EmptyState icon={<LifeBuoy />} title="No tickets yet" description={categories.length ? "Stuck with something? Raise a ticket and the right team will pick it up." : "The helpdesk isn't set up yet. Your HR team needs to add categories first."}
          action={categories.length ? <Button onClick={() => setRaising(true)}><Plus />New ticket</Button> : undefined} /></Card>
      ) : (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList items={[{ value: "active", label: "Open", count: active.length }, { value: "closed", label: "Closed", count: closed.length }]} />
          <TabsContent value="active">{list(active, <Card><EmptyState compact icon={<LifeBuoy />} title="Nothing open" description="All your tickets are closed." /></Card>)}</TabsContent>
          <TabsContent value="closed">{list(closed, <Card><EmptyState compact icon={<LifeBuoy />} title="No closed tickets" /></Card>)}</TabsContent>
        </Tabs>
      )}
      <NewTicket open={raising} onOpenChange={setRaising} categories={categories} onRaised={(id) => { setRaising(false); setOpen(id); }} />
      <TicketDrawer ticketId={open} onClose={close} />
    </>
  );
}

function NewTicket({ open, onOpenChange, categories, onRaised }: { open: boolean; onOpenChange: (o: boolean) => void; categories: CategoryOption[]; onRaised: (id: string) => void }) {
  const [categoryId, setCategoryId] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [files, setFiles] = React.useState<File[]>([]);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, start] = React.useTransition();
  const cat = categories.find((c) => c.id === categoryId);
  const reset = () => { setCategoryId(""); setTitle(""); setDescription(""); setFiles([]); setErrors({}); };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!categoryId) errs.categoryId = "Pick a category.";
    if (!title.trim()) errs.title = "Add a short subject.";
    if (!description.trim()) errs.description = "Describe what you need help with.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const fd = new FormData();
    fd.set("categoryId", categoryId); fd.set("title", title); fd.set("description", description);
    for (const f of files) fd.append("files", f);
    start(async () => {
      const r = await raiseTicketAction(fd);
      if (!r.ok) { setErrors({ [r.field ?? "form"]: r.error }); return; }
      toast.success(`Ticket ${r.data?.ref} raised`, { description: r.data?.assigneeId ? "It's been assigned to an agent." : "An agent will pick it up soon." });
      reset(); onRaised(r.data!.id);
    });
  };
  const pick = (list: FileList | null) => {
    const arr = Array.from(list ?? []);
    const big = arr.find((f) => f.size > MAX_UPLOAD_BYTES);
    if (arr.length > MAX_ATTACHMENTS) setErrors((x) => ({ ...x, files: `Attach at most ${MAX_ATTACHMENTS} files.` }));
    else if (big) setErrors((x) => ({ ...x, files: `${big.name} is larger than 5 MB.` }));
    else { setErrors((x) => { const n = { ...x }; delete n.files; return n; }); setFiles(arr); }
  };
  return (
    <Modal open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }} title="New ticket" description="Tell us what's wrong. You'll get a notification when someone replies."
      footer={<><Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" form="new-ticket" loading={busy}>Raise ticket</Button></>}>
      <form id="new-ticket" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {errors.form && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{errors.form}</p>}
        <Field label="Category" required error={errors.categoryId}
          help={cat ? (cat.first_response_sla_mins ? `Usually answered within ${formatMinutes(cat.first_response_sla_mins)}.` : "No response target for this category.") : undefined}>
          <Select value={categoryId || undefined} onValueChange={setCategoryId} placeholder="What is it about?" options={categories.map((c) => ({ value: c.id, label: c.name }))} />
        </Field>
        <Field label="Subject" required error={errors.title}><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} placeholder="e.g. Laptop won't connect to Wi-Fi" /></Field>
        <Field label="Details" required error={errors.description}><Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} rows={5} placeholder="What happened, what you tried, and anything that would help." /></Field>
        <Field label="Attachments" help={files.length ? files.map((f) => f.name).join(", ") : `Optional. Up to ${MAX_ATTACHMENTS} files: ${ACCEPT_LABEL}.`} error={errors.files}>
          <label className="inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-md border border-border-input px-3 py-1.5 text-sm hover:bg-surface-hover focus-within:outline-2 focus-within:outline-focus">
            <Paperclip className="size-4" aria-hidden />Choose files
            <input type="file" multiple accept={ACCEPT} className="sr-only" onChange={(e) => pick(e.target.files)} />
          </label>
        </Field>
      </form>
    </Modal>
  );
}
