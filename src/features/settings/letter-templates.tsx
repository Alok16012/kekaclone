"use client";
import * as React from "react";
import { Bold, Braces, Eye, FilePen, Heading2, Heading3, Italic, List, ListOrdered, MoreHorizontal, Pencil, Plus, Trash2, Underline } from "lucide-react";
import { Card, CardHeader } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Modal, Menu, ConfirmDialog, Popover } from "@/ui/overlay";
import { Field, Input } from "@/ui/field";
import { Select } from "@/ui/select";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { cn } from "@/lib/cn";
import { deleteLetterTemplateAction, saveLetterTemplateAction } from "@/app/(app)/org/documents/actions";
import { LETTER_KINDS, PLACEHOLDERS, mergeTemplate, sanitizeHtml, unknownPlaceholders } from "@/server/modules/documents/rules";

export type TemplateItem = { id: string; name: string; kind: string; body_html: string; updated_at: string; issued: number };
const kindLabel = (k: string) => LETTER_KINDS.find((x) => x.value === k)?.label ?? k;
const fmtDate = (d: string) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const PREVIEW = "[&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:font-semibold [&_li]:ml-5 [&_ol]:mb-2 [&_ol]:list-decimal [&_p]:mb-2 [&_ul]:mb-2 [&_ul]:list-disc";

export function LetterTemplates({ templates, canEdit }: { templates: TemplateItem[]; canEdit: boolean }) {
  const [editing, setEditing] = React.useState<TemplateItem | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<TemplateItem | null>(null);
  return (
    <Card>
      <CardHeader title="Letter templates" description="Write a letter once with fields like the person's name, then issue it as a PDF from their profile or exit."
        action={canEdit ? <Button size="sm" onClick={() => setEditing("new")}><Plus />New template</Button> : undefined} />
      {templates.length === 0 ? (
        <EmptyState compact icon={<FilePen />} title="No letter templates yet" description={canEdit ? "Create one for relieving, experience or any other letter you send often." : "HR hasn't added any letter templates."}
          action={canEdit ? <Button size="sm" onClick={() => setEditing("new")}><Plus />New template</Button> : undefined} />
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {templates.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-5 py-3">
              <FilePen className="size-5 shrink-0 text-text-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                {canEdit ? <button type="button" onClick={() => setEditing(t)} className="truncate text-left text-base font-medium hover:underline">{t.name}</button> : <p className="truncate text-base font-medium">{t.name}</p>}
                <p className="text-sm text-text-muted">{kindLabel(t.kind)} · edited {fmtDate(t.updated_at)}{t.issued ? ` · issued ${t.issued} ${t.issued === 1 ? "time" : "times"}` : ""}</p>
              </div>
              {canEdit && (
                <Menu trigger={<IconButton size="icon-sm" label={`Actions for ${t.name}`}><MoreHorizontal /></IconButton>}
                  items={[{ label: "Edit", icon: <Pencil />, onSelect: () => setEditing(t) }, "separator", { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setDeleting(t) }]} />
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && <TemplateEditor template={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)} title={`Delete ${deleting.name}?`}
          description={deleting.issued ? "Letters already issued from it stay in people's documents." : "This can't be undone."} confirmLabel="Delete"
          onConfirm={async () => { const r = await deleteLetterTemplateAction(deleting.id); if (r.ok) toast.success("Template deleted"); else toast.error(r.error); setDeleting(null); }} />
      )}
    </Card>
  );
}

const STARTER = "<p>{{today}}</p><p>Dear {{employee.first_name}},</p><p></p><p>For {{company.name}}</p>";

/** S50: rich-text letter editor with a field picker. Bold/italic/underline, two heading sizes and lists; nothing else survives saving. */
function TemplateEditor({ template, onClose }: { template: TemplateItem | null; onClose: () => void }) {
  const [name, setName] = React.useState(template?.name ?? "");
  const [kind, setKind] = React.useState(template?.kind ?? "other");
  const [html, setHtml] = React.useState(template?.body_html ?? STARTER);
  const [preview, setPreview] = React.useState(false);
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const editor = React.useRef<HTMLDivElement | null>(null);
  const range = React.useRef<Range | null>(null);
  const initial = React.useRef(template?.body_html ?? STARTER);

  // the editor is uncontrolled: fill it once when it mounts (and again when coming back from the preview)
  const attach = React.useCallback((el: HTMLDivElement | null) => {
    editor.current = el;
    if (el && !el.dataset.ready) { el.innerHTML = sanitizeHtml(initial.current); el.dataset.ready = "1"; }
  }, []);
  const remember = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && editor.current?.contains(sel.anchorNode)) range.current = sel.getRangeAt(0).cloneRange();
  };
  const sync = () => { if (editor.current) { setHtml(editor.current.innerHTML); initial.current = editor.current.innerHTML; } };
  const exec = (cmd: string, value?: string) => {
    const el = editor.current; if (!el) return;
    el.focus();
    if (range.current) { const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(range.current); }
    // execCommand is old but still the only built-in rich-text editing API; it keeps undo/redo working
    document.execCommand(cmd, false, value);
    remember(); sync();
  };
  const unknown = unknownPlaceholders(html);
  const save = () => start(async () => {
    setError(null);
    const r = await saveLetterTemplateAction(template?.id ?? null, { name, kind, body: editor.current?.innerHTML ?? html });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success(template ? "Template saved" : "Template created");
    onClose();
  });
  const sample = Object.fromEntries(PLACEHOLDERS.map((p) => [p.key, p.sample]));
  const tool = (label: string, icon: React.ReactNode, cmd: string, value?: string) => (
    <IconButton type="button" size="icon-sm" label={label} onMouseDown={(e) => e.preventDefault()} onClick={() => exec(cmd, value)} disabled={preview}>{icon}</IconButton>
  );

  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="lg" title={template ? "Edit letter template" : "New letter template"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>Save template</Button></>}>
      <div className="flex flex-col gap-4">
        {error && error.field !== "name" && <Banner tone="danger">{error.message}</Banner>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" required error={error?.field === "name" ? error.message : undefined}><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="e.g. Relieving letter" /></Field>
          <Field label="Kind of letter"><Select value={kind} onValueChange={setKind} options={LETTER_KINDS.map((k) => ({ value: k.value, label: k.label }))} /></Field>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium" id="letter-body-label">Letter</span>
          <div className="overflow-hidden rounded-md border border-border-input focus-within:border-focus focus-within:ring-3 focus-within:ring-focus/25">
            <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-0.5 border-b border-border bg-surface-sunken px-1.5 py-1">
              {tool("Bold", <Bold />, "bold")}{tool("Italic", <Italic />, "italic")}{tool("Underline", <Underline />, "underline")}
              <span className="mx-1 h-5 w-px bg-border" aria-hidden />
              {tool("Heading", <Heading2 />, "formatBlock", "h2")}{tool("Subheading", <Heading3 />, "formatBlock", "h3")}
              {tool("Bulleted list", <List />, "insertUnorderedList")}{tool("Numbered list", <ListOrdered />, "insertOrderedList")}
              <span className="mx-1 h-5 w-px bg-border" aria-hidden />
              <Popover align="start" className="w-72 p-1" trigger={<Button type="button" variant="ghost" size="sm" disabled={preview} onMouseDown={(e) => e.preventDefault()}><Braces />Insert field</Button>}>
                <ul role="list" className="max-h-72 overflow-y-auto">
                  {PLACEHOLDERS.map((p) => (
                    <li key={p.key}>
                      <button type="button" className="flex w-full flex-col rounded-sm px-2.5 py-1.5 text-left hover:bg-surface-hover focus-visible:bg-surface-hover" onClick={() => exec("insertText", `{{${p.key}}}`)}>
                        <span className="text-base">{p.label}</span><span className="font-mono text-xs text-text-muted">{`{{${p.key}}}`}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </Popover>
              <Button type="button" variant={preview ? "soft" : "ghost"} size="sm" className="ml-auto" aria-pressed={preview} onClick={() => { if (!preview) sync(); setPreview(!preview); }}><Eye />Preview</Button>
            </div>
            {preview ? (
              <div className={cn("min-h-72 bg-surface px-4 py-3 text-base", PREVIEW)} aria-label="Preview with sample data" dangerouslySetInnerHTML={{ __html: mergeTemplate(sanitizeHtml(html), sample).html }} />
            ) : (
              <div ref={attach} role="textbox" aria-multiline aria-labelledby="letter-body-label" contentEditable suppressContentEditableWarning
                onInput={sync} onKeyUp={remember} onMouseUp={remember} onBlur={remember}
                className={cn("min-h-72 max-h-[50vh] overflow-y-auto bg-surface px-4 py-3 text-base outline-none", PREVIEW)} />
            )}
          </div>
          <p className="text-sm text-text-muted">{preview ? "Shown with sample details. Real letters use the person's own." : "Fields in {{double braces}} are filled in for each person when you issue the letter."}</p>
          {unknown.length > 0 && <Banner tone="warning">Not a known field: {unknown.map((u) => <Badge key={u} className="mx-0.5 font-mono">{`{{${u}}}`}</Badge>)}. Use Insert field instead.</Banner>}
        </div>
      </div>
    </Modal>
  );
}
