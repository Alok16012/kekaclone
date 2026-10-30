"use client";
import * as React from "react";
import { CheckCircle2, Eye, FileText, FolderOpen, FolderPlus, Lock, MoreHorizontal, Pencil, Search, ShieldCheck, Trash2, Upload, Users } from "lucide-react";
import { PageHeader } from "@/ui/app-shell";
import { Card } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Avatar } from "@/ui/avatar";
import { Modal, Drawer, ConfirmDialog, Menu } from "@/ui/overlay";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Checkbox, RadioGroup, Switch } from "@/ui/choice";
import { Banner, EmptyState, Progress, Skeleton } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import {
  acknowledgeDocumentAction, deleteDocumentAction, deleteFolderAction, documentTrackingAction, saveFolderAction, updateDocumentAction, uploadDocumentAction,
} from "@/app/(app)/org/documents/actions";
import { ACCEPT, ACCEPT_LABEL, MAX_UPLOAD_BYTES, type FolderAccess } from "@/server/modules/documents/rules";
import { fmtSize } from "./person-documents";

export type LibDoc = {
  id: string; folder_id: string; title: string; description: string | null; file_id: string; file_name: string; mime: string; size_bytes: number;
  requires_ack: boolean; block_portal_until_ack: boolean; created_at: string; viewed_at: string | null; acknowledged_at: string | null;
  audience?: number; viewed?: number; acknowledged?: number;
};
export type LibFolder = { id: string; name: string; access: FolderAccess; docs: LibDoc[] };
type Opt = { id: string; name: string };

const fmtDate = (d: string) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

export function DocumentLibrary({ folders, manage, departments, locations, pending }: { folders: LibFolder[]; manage: boolean; departments: Opt[]; locations: Opt[]; pending: number }) {
  const [q, setQ] = React.useState("");
  const [folderDialog, setFolderDialog] = React.useState<LibFolder | "new" | null>(null);
  const [upload, setUpload] = React.useState<string | null | false>(false);   // folder id to preselect, null = none, false = closed
  const [editDoc, setEditDoc] = React.useState<LibDoc | null>(null);
  const [tracking, setTracking] = React.useState<LibDoc | null>(null);
  const [deleting, setDeleting] = React.useState<{ kind: "doc"; d: LibDoc } | { kind: "folder"; f: LibFolder } | null>(null);
  const [opened, setOpened] = React.useState<Set<string>>(new Set());
  const accessLabel = (a: FolderAccess) => a.type === "org" ? "Everyone" : (a.type === "departments" ? departments : locations).filter((x) => a.ids.includes(x.id)).map((x) => x.name).join(", ") || "No one yet";
  const match = (d: LibDoc) => !q || `${d.title} ${d.description ?? ""} ${d.file_name}`.toLowerCase().includes(q.toLowerCase());
  const shown = folders.map((f) => ({ ...f, docs: f.docs.filter(match) })).filter((f) => !q || f.docs.length);
  const total = folders.reduce((n, f) => n + f.docs.length, 0);

  return (
    <>
      <PageHeader title="Documents" description={manage ? "Company policies and files, shared with everyone or with specific teams." : "Company policies and files shared with you."}
        actions={manage ? <><Button variant="secondary" onClick={() => setFolderDialog("new")}><FolderPlus />New folder</Button><Button disabled={!folders.length} onClick={() => setUpload(null)}><Upload />Upload</Button></> : undefined} />
      {pending > 0 && <Banner tone="warning" className="mb-4" title={`${pending} ${pending === 1 ? "document needs" : "documents need"} your acknowledgement`}>Open each one, read it, then select Acknowledge.</Banner>}

      {folders.length === 0 ? (
        <Card><EmptyState icon={<FolderOpen />} title={manage ? "No folders yet" : "Nothing shared with you yet"}
          description={manage ? "Create a folder, choose who can see it, then upload policies and other documents." : "Policies and documents HR shares with you will appear here."}
          action={manage ? <Button onClick={() => setFolderDialog("new")}><FolderPlus />New folder</Button> : undefined} /></Card>
      ) : (
        <div className="flex flex-col gap-4">
          {total > 5 && <div className="max-w-sm"><Input aria-label="Search documents" leading={<Search />} placeholder="Search documents" value={q} onChange={(e) => setQ(e.target.value)} /></div>}
          {shown.length === 0 && <Card><EmptyState compact icon={<Search />} title={`No documents match “${q}”`} /></Card>}
          {shown.map((f) => (
            <Card key={f.id}>
              <div className="flex items-center gap-3 border-b border-border px-5 py-3">
                <FolderOpen className="size-5 shrink-0 text-accent-text" aria-hidden />
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-md font-semibold">{f.name}</h2>
                  {manage && <p className="flex items-center gap-1 truncate text-sm text-text-muted"><Users className="size-3.5 shrink-0" aria-hidden />Shared with {accessLabel(f.access)}</p>}
                </div>
                {manage && (
                  <Menu trigger={<IconButton size="icon-sm" label={`Folder actions for ${f.name}`}><MoreHorizontal /></IconButton>}
                    items={[{ label: "Upload here", icon: <Upload />, onSelect: () => setUpload(f.id) }, { label: "Edit folder", icon: <Pencil />, onSelect: () => setFolderDialog(f) }, "separator", { label: "Delete folder", icon: <Trash2 />, danger: true, onSelect: () => setDeleting({ kind: "folder", f }) }]} />
                )}
              </div>
              {f.docs.length === 0 ? (
                <EmptyState compact title="This folder is empty" description={manage ? "Upload a document to share it with the people who can see this folder." : undefined}
                  action={manage ? <Button size="sm" variant="secondary" onClick={() => setUpload(f.id)}><Upload />Upload</Button> : undefined} />
              ) : (
                <ul className="divide-y divide-border">
                  {f.docs.map((d) => {
                    const needsAck = d.requires_ack && !d.acknowledged_at;
                    const seen = !!d.viewed_at || opened.has(d.id);
                    return (
                      <li key={d.id} className="flex flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center">
                        <div className="flex min-w-0 flex-1 items-start gap-3">
                          <FileText className="mt-0.5 size-5 shrink-0 text-text-muted" aria-hidden />
                          <div className="min-w-0">
                            <a href={`/files/${d.file_id}`} target="_blank" rel="noreferrer" onClick={() => setOpened((s) => new Set(s).add(d.id))} className="text-base font-medium hover:underline">{d.title}</a>
                            {d.description && <p className="text-sm text-text-muted">{d.description}</p>}
                            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-muted">
                              <span className="truncate">{d.file_name} · {fmtSize(d.size_bytes)} · {fmtDate(d.created_at)}</span>
                              {d.block_portal_until_ack ? <Badge tone="warning"><Lock />Must acknowledge</Badge> : d.requires_ack ? <Badge tone="accent"><ShieldCheck />Acknowledgement needed</Badge> : null}
                              {d.acknowledged_at && <Badge tone="success"><CheckCircle2 />You acknowledged on {fmtDate(d.acknowledged_at)}</Badge>}
                            </p>
                          </div>
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center gap-2 pl-8 sm:pl-0">
                          {manage && d.audience != null && (
                            <button type="button" onClick={() => setTracking(d)} className="flex min-w-36 flex-col gap-1 rounded-md px-2 py-1 text-left hover:bg-surface-hover" aria-label={`Who has seen ${d.title}`}>
                              <span className="text-sm tabular text-text-muted">{d.requires_ack ? `${d.acknowledged} of ${d.audience} acknowledged` : `${d.viewed} of ${d.audience} viewed`}</span>
                              <Progress value={d.requires_ack ? d.acknowledged! : d.viewed!} max={Math.max(1, d.audience)} label={`${d.title} progress`} tone="success" />
                            </button>
                          )}
                          {needsAck && (
                            <Button size="sm" variant={seen ? "primary" : "secondary"} title={seen ? undefined : "Open the document first"}
                              onClick={async () => {
                                if (!seen) { toast("Open the document and read it first", { description: "Select its title to open it." }); return; }
                                const r = await acknowledgeDocumentAction(d.id);
                                if (r.ok) toast.success("Acknowledged", { description: d.title }); else toast.error(r.error);
                              }}><CheckCircle2 />Acknowledge</Button>
                          )}
                          {manage && (
                            <Menu trigger={<IconButton size="icon-sm" label={`Actions for ${d.title}`}><MoreHorizontal /></IconButton>}
                              items={[{ label: "Who has seen it", icon: <Eye />, onSelect: () => setTracking(d) }, { label: "Edit", icon: <Pencil />, onSelect: () => setEditDoc(d) }, "separator", { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setDeleting({ kind: "doc", d }) }]} />
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          ))}
        </div>
      )}

      {folderDialog && <FolderDialog folder={folderDialog === "new" ? null : folderDialog} departments={departments} locations={locations} onClose={() => setFolderDialog(null)} />}
      {upload !== false && <UploadDialog folders={folders} folderId={upload} onClose={() => setUpload(false)} />}
      {editDoc && <EditDocDialog doc={editDoc} folders={folders} onClose={() => setEditDoc(null)} />}
      <TrackingDrawer doc={tracking} onClose={() => setTracking(null)} />
      {deleting && (
        <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)}
          title={deleting.kind === "doc" ? `Delete ${deleting.d.title}?` : `Delete the ${deleting.f.name} folder?`}
          description={deleting.kind === "doc" ? "People will no longer see it, and its view and acknowledgement history is removed." : deleting.f.docs.length ? "Move or delete the documents in it first." : "The folder is empty, so nothing else is lost."}
          confirmLabel="Delete" onConfirm={async () => {
            const r = deleting.kind === "doc" ? await deleteDocumentAction(deleting.d.id) : await deleteFolderAction(deleting.f.id);
            if (r.ok) toast.success("Deleted"); else toast.error(r.error);
            setDeleting(null);
          }} />
      )}
    </>
  );
}

function FolderDialog({ folder, departments, locations, onClose }: { folder: LibFolder | null; departments: Opt[]; locations: Opt[]; onClose: () => void }) {
  const [name, setName] = React.useState(folder?.name ?? "");
  const [type, setType] = React.useState<FolderAccess["type"]>(folder?.access.type ?? "org");
  const [ids, setIds] = React.useState<string[]>(folder && folder.access.type !== "org" ? folder.access.ids : []);
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const options = type === "departments" ? departments : type === "locations" ? locations : [];
  const save = () => start(async () => {
    const r = await saveFolderAction(folder?.id ?? null, { name, access: type === "org" ? { type } : { type, ids: ids.filter((id) => options.some((o) => o.id === id)) } });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success(folder ? "Folder updated" : "Folder created");
    onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="sm" title={folder ? "Edit folder" : "New folder"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>{folder ? "Save" : "Create folder"}</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && error.field !== "name" && <Banner tone="danger">{error.message}</Banner>}
        <Field label="Folder name" required error={error?.field === "name" ? error.message : undefined}><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoFocus /></Field>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">Who can see it</legend>
          <RadioGroup value={type} onValueChange={(v) => { setType(v as FolderAccess["type"]); setIds([]); }}
            options={[{ value: "org", label: "Everyone in the company" }, { value: "departments", label: "Only some departments" }, { value: "locations", label: "Only some locations" }]} />
        </fieldset>
        {type !== "org" && (
          <fieldset className="max-h-56 overflow-y-auto rounded-md border border-border p-3">
            <legend className="sr-only">{type === "departments" ? "Departments" : "Locations"}</legend>
            {options.length === 0 ? <p className="text-sm text-text-muted">None set up yet.</p> : (
              <div className="flex flex-col gap-2">
                {options.map((o) => <Checkbox key={o.id} label={o.name} checked={ids.includes(o.id)} onCheckedChange={(c) => setIds((s) => (c ? [...s, o.id] : s.filter((x) => x !== o.id)))} />)}
              </div>
            )}
          </fieldset>
        )}
        <p className="text-sm text-text-muted">HR can always see every folder.</p>
      </form>
    </Modal>
  );
}

function AckSwitches({ ack, block, setAck, setBlock }: { ack: boolean; block: boolean; setAck: (v: boolean) => void; setBlock: (v: boolean) => void }) {
  return (
    <div className="flex flex-col gap-3 rounded-md bg-surface-sunken p-3">
      <Switch label="People must acknowledge it" checked={ack || block} disabled={block} onCheckedChange={setAck} />
      <Switch label="Block erp until they acknowledge" checked={block} onCheckedChange={(v) => { setBlock(v); if (v) setAck(true); }} />
      <p className="text-sm text-text-muted">{block ? "When they next open erp, they'll have to read and acknowledge this before doing anything else." : ack ? "They'll be reminded, and you can track who has acknowledged." : "People can read it; you'll still see who opened it."}</p>
    </div>
  );
}

function UploadDialog({ folders, folderId, onClose }: { folders: LibFolder[]; folderId: string | null; onClose: () => void }) {
  const [folder, setFolder] = React.useState<string | undefined>(folderId ?? (folders.length === 1 ? folders[0].id : undefined));
  const [ack, setAck] = React.useState(false);
  const [block, setBlock] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const form = React.useRef<HTMLFormElement>(null);
  const submit = () => start(async () => {
    setError(null);
    const fd = new FormData(form.current!);
    const f = fd.get("file");
    if (!folder) { setError({ message: "Pick a folder.", field: "folderId" }); return; }
    if (!(f instanceof File) || !f.size) { setError({ message: "Choose a file to upload.", field: "file" }); return; }
    if (f.size > MAX_UPLOAD_BYTES) { setError({ message: "This file is larger than 5 MB.", field: "file" }); return; }
    fd.set("folderId", folder); fd.set("requiresAck", ack || block ? "1" : "0"); fd.set("blockUntilAck", block ? "1" : "0");
    const r = await uploadDocumentAction(fd);
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success("Document uploaded", { description: ack || block ? "Everyone who can see it has been asked to acknowledge it." : undefined });
    onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="md" title="Upload a document"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={submit}>Upload</Button></>}>
      <form ref={form} className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        {error && !["file", "folderId"].includes(error.field ?? "") && <Banner tone="danger">{error.message}</Banner>}
        <Field label="File" required help={ACCEPT_LABEL} error={error?.field === "file" ? error.message : undefined}><Input name="file" type="file" accept={ACCEPT} className="py-1.5" /></Field>
        <Field label="Folder" required error={error?.field === "folderId" ? error.message : undefined}>
          <Select value={folder} onValueChange={setFolder} placeholder="Pick a folder" options={folders.map((f) => ({ value: f.id, label: f.name }))} />
        </Field>
        <Field label="Title" help="Leave empty to use the file name"><Input name="title" maxLength={160} /></Field>
        <Field label="Description"><Textarea name="description" maxLength={1000} rows={2} /></Field>
        <AckSwitches ack={ack} block={block} setAck={setAck} setBlock={setBlock} />
      </form>
    </Modal>
  );
}

function EditDocDialog({ doc, folders, onClose }: { doc: LibDoc; folders: LibFolder[]; onClose: () => void }) {
  const [title, setTitle] = React.useState(doc.title);
  const [description, setDescription] = React.useState(doc.description ?? "");
  const [folder, setFolder] = React.useState(doc.folder_id);
  const [ack, setAck] = React.useState(doc.requires_ack);
  const [block, setBlock] = React.useState(doc.block_portal_until_ack);
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    const r = await updateDocumentAction(doc.id, { title, description: description || null, folderId: folder, requiresAck: ack || block, blockUntilAck: block });
    if (!r.ok) { setError(r.error); return; }
    toast.success("Document updated");
    onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="md" title="Edit document"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>Save</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Title" required><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} /></Field>
        <Field label="Description"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} rows={2} /></Field>
        <Field label="Folder"><Select value={folder} onValueChange={setFolder} options={folders.map((f) => ({ value: f.id, label: f.name }))} /></Field>
        <AckSwitches ack={ack} block={block} setAck={setAck} setBlock={setBlock} />
      </form>
    </Modal>
  );
}

type Tracking = { title: string; requiresAck: boolean; rows: { employee_id: string; name: string; department: string | null; viewed_at: string | null; acknowledged_at: string | null }[] };

function TrackingDrawer({ doc, onClose }: { doc: LibDoc | null; onClose: () => void }) {
  const [data, setData] = React.useState<{ id: string; t?: Tracking; error?: string } | null>(null);
  const [filter, setFilter] = React.useState<"all" | "pending" | "done">("all");
  React.useEffect(() => {
    if (!doc) return;
    let live = true;
    documentTrackingAction(doc.id).then((r) => { if (live) setData(r.ok ? { id: doc.id, t: r.data } : { id: doc.id, error: r.error }); });
    return () => { live = false; };
  }, [doc]);
  const cur = doc && data?.id === doc.id ? data : null;
  const t = cur?.t;
  const done = (r: Tracking["rows"][number]) => (t?.requiresAck ? !!r.acknowledged_at : !!r.viewed_at);
  const rows = t ? t.rows.filter((r) => filter === "all" || (filter === "done") === done(r)) : [];
  const count = t ? t.rows.filter(done).length : 0;
  return (
    <Drawer open={!!doc} onOpenChange={(o) => { if (!o) { setFilter("all"); onClose(); } }} title={doc?.title ?? ""} description={t ? `${count} of ${t.rows.length} ${t.requiresAck ? "acknowledged" : "viewed"}` : undefined}>
      {cur?.error ? <Banner tone="danger">{cur.error}</Banner> : !t ? (
        <div className="flex flex-col gap-3" aria-busy aria-label="Loading"><Skeleton className="h-4 w-1/2" />{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
      ) : (
        <div className="flex flex-col gap-4">
          <Progress value={count} max={Math.max(1, t.rows.length)} label="Progress" tone="success" />
          <Select value={filter} onValueChange={(v) => setFilter(v as typeof filter)} options={[{ value: "all", label: `Everyone (${t.rows.length})` }, { value: "pending", label: `Not yet (${t.rows.length - count})` }, { value: "done", label: `${t.requiresAck ? "Acknowledged" : "Viewed"} (${count})` }]} />
          {rows.length === 0 ? <EmptyState compact title={filter === "pending" ? "Everyone's done" : "No one here"} /> : (
            <ul className="divide-y divide-border">
              {rows.map((r) => (
                <li key={r.employee_id} className="flex items-center gap-3 py-2.5">
                  <Avatar name={r.name} size="sm" />
                  <div className="min-w-0 flex-1"><p className="truncate text-base font-medium">{r.name}</p><p className="truncate text-sm text-text-muted">{r.department ?? "No department"}</p></div>
                  {r.acknowledged_at ? <Badge tone="success"><CheckCircle2 />Acknowledged {fmtDate(r.acknowledged_at)}</Badge>
                    : r.viewed_at ? <Badge tone="accent"><Eye />Viewed {fmtDate(r.viewed_at)}</Badge> : <Badge>Not opened</Badge>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Drawer>
  );
}
