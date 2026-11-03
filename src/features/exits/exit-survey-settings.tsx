"use client";
import * as React from "react";
import { ArrowDown, ArrowUp, ClipboardList, Pencil, Plus, Trash2 } from "lucide-react";
import { Card, CardHeader } from "@/ui/card";
import { Button, IconButton } from "@/ui/button";
import { Badge } from "@/ui/badge";
import { Modal, ConfirmDialog } from "@/ui/overlay";
import { Field, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Checkbox } from "@/ui/choice";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { deleteExitQuestionAction, moveExitQuestionAction, saveExitQuestionAction } from "@/app/(app)/org/exits/actions";
import { EXIT_QUESTION_LABEL, EXIT_QUESTION_TYPES, type ExitQuestion, type ExitQuestionType } from "@/server/modules/exits/survey-rules";

/** Settings → Exit survey: the questions every leaver is asked when their exit starts. */
export function ExitSurveySettings({ questions, canEdit }: { questions: ExitQuestion[]; canEdit: boolean }) {
  const [editing, setEditing] = React.useState<ExitQuestion | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<ExitQuestion | null>(null);
  const [busy, start] = React.useTransition();
  const move = (id: string, dir: "up" | "down") => start(async () => { const r = await moveExitQuestionAction(id, dir); if (!r.ok) toast.error(r.error); });
  return (
    <Card>
      <CardHeader title="Exit survey" description="Sent to the person as soon as their exit starts, with a reminder email. Answers are tied to the exit and shown to HR under Exits → Survey results."
        action={canEdit ? <Button size="sm" onClick={() => setEditing("new")}><Plus />Add question</Button> : undefined} />
      {questions.length === 0 ? <EmptyState compact icon={<ClipboardList />} title="No questions yet" description={canEdit ? "Add a question, or start an exit to get the standard set." : undefined} /> : (
        <ol className="divide-y divide-border border-t border-border">
          {questions.map((q, i) => (
            <li key={q.id} className="flex items-start gap-3 px-5 py-3">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-pill bg-surface-hover text-sm tabular">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="text-base font-medium">{q.prompt}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-text-muted"><Badge tone="neutral" size="sm">{EXIT_QUESTION_LABEL[q.type]}</Badge>{q.required ? "Required" : "Optional"}{q.type === "choice" && q.options.length > 0 && <span>· {q.options.join(", ")}</span>}</p>
              </div>
              {canEdit && (
                <div className="flex shrink-0 items-center gap-0.5">
                  <IconButton size="icon-sm" variant="ghost" label="Move up" disabled={i === 0 || busy} onClick={() => move(q.id, "up")}><ArrowUp /></IconButton>
                  <IconButton size="icon-sm" variant="ghost" label="Move down" disabled={i === questions.length - 1 || busy} onClick={() => move(q.id, "down")}><ArrowDown /></IconButton>
                  <IconButton size="icon-sm" variant="ghost" label="Edit question" onClick={() => setEditing(q)}><Pencil /></IconButton>
                  <IconButton size="icon-sm" variant="ghost" label="Remove question" onClick={() => setDeleting(q)}><Trash2 /></IconButton>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {editing && <QuestionDialog q={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog open onOpenChange={(o) => !o && setDeleting(null)} title="Remove this question?" description="If anyone has answered it already, it's kept in past results but no longer asked." confirmLabel="Remove"
          onConfirm={async () => { const r = await deleteExitQuestionAction(deleting.id); if (r.ok) toast.success("Question removed"); else toast.error(r.error); setDeleting(null); }} />
      )}
    </Card>
  );
}

function QuestionDialog({ q, onClose }: { q: ExitQuestion | null; onClose: () => void }) {
  const [prompt, setPrompt] = React.useState(q?.prompt ?? "");
  const [type, setType] = React.useState<ExitQuestionType>(q?.type ?? "text");
  const [options, setOptions] = React.useState((q?.options ?? []).join("\n"));
  const [required, setRequired] = React.useState(q?.required ?? true);
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const save = () => start(async () => {
    const r = await saveExitQuestionAction(q?.id ?? null, { prompt, type, options: options.split("\n").map((s) => s.trim()).filter(Boolean), required });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success(q ? "Question updated" : "Question added"); onClose();
  });
  const err = (f: string) => (error?.field === f ? error.message : undefined);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="sm" title={q ? "Edit question" : "Add a question"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>Save</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        <Field label="Question" required error={err("prompt")}><Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={2} maxLength={300} autoFocus /></Field>
        <Field label="Answer type" required error={err("type")}><Select value={type} onValueChange={(v) => setType(v as ExitQuestionType)} options={EXIT_QUESTION_TYPES.map((t) => ({ value: t, label: EXIT_QUESTION_LABEL[t] }))} /></Field>
        {type === "choice" && <Field label="Choices" required help="One per line" error={err("options")}><Textarea value={options} onChange={(e) => setOptions(e.target.value)} rows={4} /></Field>}
        <Checkbox label="Required" checked={required} onCheckedChange={(c) => setRequired(!!c)} />
      </form>
    </Modal>
  );
}
