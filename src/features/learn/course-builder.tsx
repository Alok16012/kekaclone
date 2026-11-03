"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowDown, ArrowLeft, ArrowUp, BookOpenText, CheckCircle2, ExternalLink, Eye, FileText, HelpCircle, MoreHorizontal, Pencil, PlayCircle, Plus, Trash2, UserPlus, Users } from "lucide-react";
import { Card, CardHeader } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Modal, ConfirmDialog, Menu } from "@/ui/overlay";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Checkbox, RadioGroup, Switch } from "@/ui/choice";
import { EmployeePicker, type Person } from "@/ui/employee-picker";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { deleteAssignmentAction, deleteCourseAction, deleteModuleAction, enrollPeopleAction, moveModuleAction, saveAssignmentAction, saveModuleAction, setCourseStatusAction } from "@/app/(app)/learn/actions";
import { MODULE_KIND_LABEL, MODULE_KINDS, RULE_KINDS, RULE_LABEL, type ModuleContent, type ModuleKind, type Question, type Rule } from "@/server/modules/learn/rules";
import { CourseDialog, type CourseListRow } from "./admin-courses";

export type ModuleItem = { id: string; kind: ModuleKind; title: string; content: ModuleContent; file_id: string | null; file_name: string | null; position: number };
export type AssignmentItem = { id: string; name: string; rule: Rule; description: string; due_in_days: number | null; reminder_days_before: number | null; is_active: boolean; enrolled: number };
export type Lookups = { people: Person[]; departments: { id: string; name: string }[]; locations: { id: string; name: string }[]; designations: { id: string; name: string }[] };
const ICON: Record<ModuleKind, React.ComponentType<{ className?: string }>> = { video: PlayCircle, document: FileText, text: BookOpenText, quiz: HelpCircle, link: ExternalLink };
const TONE: Record<CourseListRow["status"], "neutral" | "success" | "warning"> = { draft: "warning", published: "success", archived: "neutral" };

/** S171: the builder. Modules in order (video, document, reading, link, quiz), assignment rules with due dates and reminders, manual enrolment, publish. */
export function CourseBuilder({ course, modules, assignments, lookups, canEdit }: { course: CourseListRow; modules: ModuleItem[]; assignments: AssignmentItem[]; lookups: Lookups; canEdit: boolean }) {
  const [editing, setEditing] = React.useState(false);
  const [mod, setMod] = React.useState<ModuleItem | "new" | null>(null);
  const [asg, setAsg] = React.useState<AssignmentItem | "new" | null>(null);
  const [enrol, setEnrol] = React.useState(false);
  const [confirm, setConfirm] = React.useState<{ title: string; description: string; run: () => Promise<{ ok: boolean; error?: string }> } | null>(null);
  const [busy, start] = React.useTransition();
  const setStatus = (s: CourseListRow["status"]) => start(async () => {
    const r = await setCourseStatusAction(course.id, s);
    if (r.ok) toast.success(s === "published" ? "Course published" : s === "archived" ? "Course archived" : "Course back in draft", s === "published" ? { description: "People matching the assignment rules are being enrolled." } : undefined);
    else toast.error(r.error);
  });
  const move = (m: ModuleItem, dir: -1 | 1) => start(async () => { const r = await moveModuleAction(course.id, m.id, dir); if (!r.ok) toast.error(r.error); });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm"><Link href="/learn/admin"><ArrowLeft />All courses</Link></Button>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button asChild variant="secondary" size="sm"><Link href={`/learn/courses/${course.id}`}><Eye />Preview</Link></Button>
          {canEdit && <Button variant="secondary" size="sm" onClick={() => setEditing(true)}><Pencil />Edit details</Button>}
          {canEdit && course.status !== "published" && <Button size="sm" onClick={() => setStatus("published")} loading={busy} disabled={modules.length === 0}><CheckCircle2 />Publish</Button>}
          {canEdit && <Menu trigger={<IconButton size="icon-sm" label="More"><MoreHorizontal /></IconButton>} items={[
            ...(course.status === "published" ? [{ label: "Unpublish (back to draft)", onSelect: () => setStatus("draft") }] : []),
            ...(course.status !== "archived" ? [{ label: "Archive", onSelect: () => setStatus("archived") }] : [{ label: "Restore to draft", onSelect: () => setStatus("draft") }]),
            { label: "Delete course", icon: <Trash2 />, danger: true, disabled: course.enrolled > 0, onSelect: () => setConfirm({ title: `Delete ${course.title}?`, description: "Only courses nobody is enrolled in can be deleted.", run: () => deleteCourseAction(course.id) }) },
          ]} />}
        </div>
      </div>
      <Card className="p-5">
        <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">{course.title}<Badge tone={TONE[course.status]}>{course.status === "published" ? "Published" : course.status === "draft" ? "Draft" : "Archived"}</Badge></h2>
        {course.description && <p className="mt-2 max-w-prose text-base">{course.description}</p>}
        <p className="mt-2 text-sm text-text-muted">{modules.length} {modules.length === 1 ? "module" : "modules"}{course.estimated_minutes ? ` · about ${course.estimated_minutes} min` : ""} · {course.certificate ? "certificate on completion" : "no certificate"} · {course.enrolled} enrolled, {course.completed} completed{course.overdue ? `, ${course.overdue} overdue` : ""}</p>
      </Card>
      {course.status === "draft" && modules.length === 0 && canEdit && <Banner tone="info" title="Add at least one module, then publish">Learners only see published courses. Assignment rules enrol people the moment you publish.</Banner>}

      <Tabs defaultValue="modules">
        <TabsList items={[{ value: "modules", label: "Modules", count: modules.length }, { value: "assign", label: "Assign", count: assignments.length }]} />
        <TabsContent value="modules">
          <Card>
            <CardHeader title="Modules" description="People go through them in this order. A quiz is done when it's passed." action={canEdit ? <Button size="sm" onClick={() => setMod("new")}><Plus />Add module</Button> : undefined} />
            {modules.length === 0 ? <EmptyState compact icon={<BookOpenText />} title="No modules yet" description="Add a video, a document, a reading, a web link or a quiz." /> : (
              <ol className="divide-y divide-border border-t border-border">
                {modules.map((m, i) => {
                  const Icon = ICON[m.kind];
                  return (
                    <li key={m.id} className="flex items-center gap-3 px-5 py-3">
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent-text" aria-hidden><Icon className="size-4" /></span>
                      <div className="min-w-0 flex-1"><p className="truncate text-base font-medium">{i + 1}. {m.title}</p><p className="truncate text-sm text-text-muted">{MODULE_KIND_LABEL[m.kind]}{m.kind === "quiz" && m.content.kind === "quiz" ? ` · ${m.content.questions.length} questions, pass ${m.content.pass_pct}%` : m.file_name ? ` · ${m.file_name}` : m.content.kind === "video" && m.content.url ? ` · ${m.content.url}` : m.content.kind === "link" ? ` · ${m.content.url}` : ""}</p></div>
                      {canEdit && <>
                        <IconButton size="icon-sm" label="Move up" disabled={i === 0 || busy} onClick={() => move(m, -1)}><ArrowUp /></IconButton>
                        <IconButton size="icon-sm" label="Move down" disabled={i === modules.length - 1 || busy} onClick={() => move(m, 1)}><ArrowDown /></IconButton>
                        <Menu trigger={<IconButton size="icon-sm" label={`More for ${m.title}`}><MoreHorizontal /></IconButton>} items={[{ label: "Edit", icon: <Pencil />, onSelect: () => setMod(m) }, { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setConfirm({ title: `Delete ${m.title}?`, description: "People still in progress will have their progress recalculated.", run: () => deleteModuleAction(course.id, m.id) }) }]} />
                      </>}
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>
        </TabsContent>
        <TabsContent value="assign">
          <div className="flex flex-col gap-4">
            <Card>
              <CardHeader title="Assignment rules" description="Who gets this course automatically, with a due date and reminders. New joiners and department moves are picked up by the daily job." action={canEdit ? <Button size="sm" onClick={() => setAsg("new")}><Plus />Add rule</Button> : undefined} />
              {assignments.length === 0 ? <EmptyState compact icon={<Users />} title="No rules yet" description="For example: everyone, due in 30 days; or new joiners in their first 90 days." /> : (
                <ul className="divide-y divide-border border-t border-border">
                  {assignments.map((a) => (
                    <li key={a.id} className="flex items-center gap-3 px-5 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-2 text-base font-medium">{a.name}{!a.is_active && <Badge tone="neutral">Paused</Badge>}</p>
                        <p className="text-sm text-text-muted">{a.description}{a.due_in_days ? ` · due ${a.due_in_days} days after enrolment` : " · no due date"}{a.reminder_days_before != null ? ` · reminders from ${a.reminder_days_before} days before` : ""}</p>
                      </div>
                      <span className="text-sm tabular text-text-muted">{a.enrolled} enrolled</span>
                      {canEdit && <Menu trigger={<IconButton size="icon-sm" label={`More for ${a.name}`}><MoreHorizontal /></IconButton>} items={[{ label: "Edit", icon: <Pencil />, onSelect: () => setAsg(a) }, { label: "Delete", icon: <Trash2 />, danger: true, onSelect: () => setConfirm({ title: `Delete rule ${a.name}?`, description: "People already enrolled keep the course.", run: () => deleteAssignmentAction(course.id, a.id) }) }]} />}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            {canEdit && (
              <Card className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center">
                <div className="flex-1"><p className="text-base font-medium">Enrol specific people</p><p className="text-sm text-text-muted">Hand-pick people outside the rules. The course must be published.</p></div>
                <Button variant="secondary" size="sm" onClick={() => setEnrol(true)} disabled={course.status !== "published"}><UserPlus />Enrol people</Button>
              </Card>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {editing && <CourseDialog course={course} onClose={() => setEditing(false)} />}
      {mod && <ModuleDialog key={mod === "new" ? "new" : mod.id} courseId={course.id} module={mod === "new" ? null : mod} onClose={() => setMod(null)} />}
      {asg && <AssignmentDialog key={asg === "new" ? "new" : asg.id} courseId={course.id} assignment={asg === "new" ? null : asg} lookups={lookups} onClose={() => setAsg(null)} />}
      {enrol && <EnrolDialog courseId={course.id} people={lookups.people} onClose={() => setEnrol(false)} />}
      <ConfirmDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)} title={confirm?.title ?? ""} description={confirm?.description ?? ""} confirmLabel="Delete"
        onConfirm={async () => { if (!confirm) return; const r = await confirm.run(); if (r.ok) toast.success("Deleted"); else toast.error(r.error ?? "Something went wrong."); setConfirm(null); }} />
    </div>
  );
}

function ModuleDialog({ courseId, module, onClose }: { courseId: string; module: ModuleItem | null; onClose: () => void }) {
  const c = module?.content;
  const [kind, setKind] = React.useState<ModuleKind>(module?.kind ?? "video");
  const [title, setTitle] = React.useState(module?.title ?? "");
  const [url, setUrl] = React.useState(c && (c.kind === "video" || c.kind === "link") ? (c.url ?? "") : "");
  const [html, setHtml] = React.useState(c?.kind === "text" ? c.html : "");
  const [note, setNote] = React.useState(c?.kind === "document" ? (c.note ?? "") : "");
  const [passPct, setPassPct] = React.useState(c?.kind === "quiz" ? String(c.pass_pct) : "70");
  const [questions, setQuestions] = React.useState<Question[]>(c?.kind === "quiz" ? c.questions : [{ id: "q1", text: "", options: ["", ""], correct: 0 }]);
  const [file, setFile] = React.useState<File | null>(null);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, start] = React.useTransition();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const form = new FormData();
    form.set("courseId", courseId); if (module) form.set("id", module.id);
    form.set("kind", kind); form.set("title", title);
    const content = kind === "video" ? { url } : kind === "link" ? { url } : kind === "text" ? { html } : kind === "document" ? { note } : { pass_pct: Number(passPct), questions };
    form.set("content", JSON.stringify(content));
    if (file) form.set("file", file);
    start(async () => {
      const r = await saveModuleAction(form);
      if (!r.ok) { setErrors({ [r.field ?? "form"]: r.error }); return; }
      toast.success(module ? "Module saved" : "Module added"); onClose();
    });
  };
  const setQ = (i: number, patch: Partial<Question>) => setQuestions((qs) => qs.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={module ? `Edit ${module.title}` : "Add a module"} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="module-form" loading={busy}>Save</Button></>}>
      <form id="module-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {errors.form && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{errors.form}</p>}
        <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
          <Field label="Title" required error={errors.title}><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} /></Field>
          <Field label="Type" error={errors.kind}><Select value={kind} onValueChange={(v) => setKind(v as ModuleKind)} options={MODULE_KINDS.map((k) => ({ value: k, label: MODULE_KIND_LABEL[k] }))} disabled={!!module} /></Field>
        </div>
        {kind === "video" && <>
          <Field label="Video link" help="YouTube, Vimeo or a direct .mp4 link. Leave empty if you upload a file." error={errors.url}><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" /></Field>
          <Field label="Or upload a video" help={`MP4 or WebM up to 5 MB${module?.file_name ? ` · currently ${module.file_name}` : ""}`} error={errors.file}><Input type="file" accept="video/mp4,video/webm,.mp4,.webm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
        </>}
        {kind === "document" && <>
          <Field label="File" help={`PDF, Word, Excel, PowerPoint, image or text up to 5 MB${module?.file_name ? ` · currently ${module.file_name}` : ""}`} error={errors.file}><Input type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.txt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
          <Field label="Note to learners"><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
        </>}
        {kind === "link" && <Field label="Web address" required error={errors.url}><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" /></Field>}
        {kind === "text" && <Field label="Reading" help="Simple HTML is fine: <p>, <h2>, <ul>, <li>, <strong>, <a>." error={errors.html}><Textarea value={html} onChange={(e) => setHtml(e.target.value)} rows={10} maxLength={50000} /></Field>}
        {kind === "quiz" && (
          <div className="flex flex-col gap-4">
            <Field label="Pass mark (%)" error={errors.pass_pct} className="sm:w-40"><Input type="number" min={1} max={100} inputMode="numeric" value={passPct} onChange={(e) => setPassPct(e.target.value)} /></Field>
            {errors.questions && <p role="alert" className="text-sm text-danger-text">{errors.questions}</p>}
            <ol className="flex flex-col gap-4">
              {questions.map((q, i) => (
                <li key={q.id} className="rounded-md border border-border p-3">
                  <div className="flex items-start gap-2">
                    <Field label={`Question ${i + 1}`} className="flex-1" error={errors[`questions.${i}.text`]}><Input value={q.text} onChange={(e) => setQ(i, { text: e.target.value })} maxLength={500} /></Field>
                    <IconButton label={`Remove question ${i + 1}`} size="icon-sm" className="mt-6" onClick={() => setQuestions((qs) => qs.filter((_, j) => j !== i))} disabled={questions.length === 1}><Trash2 /></IconButton>
                  </div>
                  <fieldset className="mt-3">
                    <legend className="mb-1.5 text-sm text-text-muted">Options: tick the right answer</legend>
                    {(errors[`questions.${i}.options`] || errors[`questions.${i}.correct`]) && <p role="alert" className="mb-1 text-sm text-danger-text">{errors[`questions.${i}.options`] ?? errors[`questions.${i}.correct`]}</p>}
                    <div className="flex flex-col gap-2">
                      {q.options.map((o, j) => (
                        <div key={j} className="flex items-center gap-2">
                          <Checkbox aria-label={`Option ${j + 1} is correct`} checked={q.correct === j} onCheckedChange={(v) => v && setQ(i, { correct: j })} />
                          <Input value={o} onChange={(e) => setQ(i, { options: q.options.map((x, k) => (k === j ? e.target.value : x)) })} maxLength={200} placeholder={`Option ${j + 1}`} />
                          <IconButton label={`Remove option ${j + 1}`} size="icon-sm" disabled={q.options.length <= 2} onClick={() => setQ(i, { options: q.options.filter((_, k) => k !== j), correct: q.correct >= j && q.correct > 0 ? q.correct - 1 : q.correct })}><Trash2 /></IconButton>
                        </div>
                      ))}
                    </div>
                    <Button variant="ghost" size="sm" className="mt-2" onClick={() => setQ(i, { options: [...q.options, ""] })} disabled={q.options.length >= 8}><Plus />Add option</Button>
                  </fieldset>
                </li>
              ))}
            </ol>
            <Button variant="secondary" size="sm" className="self-start" onClick={() => setQuestions((qs) => [...qs, { id: `q${Date.now()}`, text: "", options: ["", ""], correct: 0 }])} disabled={questions.length >= 50}><Plus />Add question</Button>
          </div>
        )}
      </form>
    </Modal>
  );
}

function AssignmentDialog({ courseId, assignment, lookups, onClose }: { courseId: string; assignment: AssignmentItem | null; lookups: Lookups; onClose: () => void }) {
  const r = assignment?.rule;
  const [name, setName] = React.useState(assignment?.name ?? "");
  const [kind, setKind] = React.useState<Rule["kind"]>(r?.kind ?? "everyone");
  const [ids, setIds] = React.useState<string[]>(r && "ids" in r ? r.ids : []);
  const [within, setWithin] = React.useState(r?.kind === "new_joiners" ? String(r.within_days) : "90");
  const [due, setDue] = React.useState(assignment?.due_in_days == null ? "" : String(assignment.due_in_days));
  const [remind, setRemind] = React.useState(assignment?.reminder_days_before == null ? "" : String(assignment.reminder_days_before));
  const [active, setActive] = React.useState(assignment?.is_active ?? true);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, start] = React.useTransition();
  const options = kind === "departments" ? lookups.departments : kind === "locations" ? lookups.locations : kind === "designations" ? lookups.designations : [];
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const rule = kind === "everyone" ? { kind } : kind === "new_joiners" ? { kind, within_days: Number(within) } : { kind, ids };
    start(async () => {
      const res = await saveAssignmentAction(courseId, assignment?.id ?? null, { name: name || RULE_LABEL[kind], rule, dueInDays: due === "" ? null : Number(due), reminderDaysBefore: remind === "" ? null : Number(remind), isActive: active });
      if (!res.ok) { setErrors({ [res.field ?? "form"]: res.error }); return; }
      toast.success(assignment ? "Rule saved" : "Rule added", res.data?.enrolled ? { description: `${res.data.enrolled} ${res.data.enrolled === 1 ? "person" : "people"} enrolled.` } : undefined);
      onClose();
    });
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={assignment ? "Edit rule" : "Add an assignment rule"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="asg-form" loading={busy}>Save</Button></>}>
      <form id="asg-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        {errors.form && <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger-text">{errors.form}</p>}
        <Field label="Name" help="For your own reference"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder={RULE_LABEL[kind]} /></Field>
        <Field label="Who" error={errors.rule}>
          <RadioGroup value={kind} onValueChange={(v) => { setKind(v as Rule["kind"]); setIds([]); }} options={RULE_KINDS.map((k) => ({ value: k, label: RULE_LABEL[k] }))} />
        </Field>
        {kind === "people" && <Field label="People"><EmployeePicker people={lookups.people} value={ids} onChange={setIds} multiple /></Field>}
        {(kind === "departments" || kind === "locations" || kind === "designations") && (
          <Field label={RULE_LABEL[kind]}>
            <div className="grid gap-2 sm:grid-cols-2">{options.map((o) => <Checkbox key={o.id} label={o.name} checked={ids.includes(o.id)} onCheckedChange={(c) => setIds((x) => (c ? [...x, o.id] : x.filter((y) => y !== o.id)))} />)}</div>
          </Field>
        )}
        {kind === "new_joiners" && <Field label="Within their first (days)" className="sm:w-48"><Input type="number" min={1} max={365} inputMode="numeric" value={within} onChange={(e) => setWithin(e.target.value)} /></Field>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Due in (days after enrolment)" help="Leave empty for no due date" error={errors.dueInDays}><Input type="number" min={1} max={365} inputMode="numeric" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          <Field label="Remind from (days before due)" help="Daily until done; empty for none" error={errors.reminderDaysBefore}><Input type="number" min={0} max={90} inputMode="numeric" value={remind} onChange={(e) => setRemind(e.target.value)} /></Field>
        </div>
        <Switch label="Rule is active" checked={active} onCheckedChange={(c) => setActive(!!c)} />
      </form>
    </Modal>
  );
}

function EnrolDialog({ courseId, people, onClose }: { courseId: string; people: Person[]; onClose: () => void }) {
  const [ids, setIds] = React.useState<string[]>([]);
  const [due, setDue] = React.useState("");
  const [busy, start] = React.useTransition();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ids.length) { toast.error("Pick at least one person."); return; }
    start(async () => {
      const r = await enrollPeopleAction(courseId, ids, due === "" ? null : Number(due));
      if (!r.ok) { toast.error(r.error); return; }
      toast.success(`${r.data ?? 0} ${r.data === 1 ? "person" : "people"} enrolled`); onClose();
    });
  };
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="Enrol people" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="enrol-form" loading={busy}>Enrol</Button></>}>
      <form id="enrol-form" onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Field label="People" required><EmployeePicker people={people} value={ids} onChange={setIds} multiple /></Field>
        <Field label="Due in (days)" help="Leave empty for no due date" className="sm:w-48"><Input type="number" min={1} max={365} inputMode="numeric" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
      </form>
    </Modal>
  );
}
