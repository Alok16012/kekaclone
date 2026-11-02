"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, BarChart3, Lock, MoreHorizontal, Pencil, Plus, Rocket, Square, Trash2, X } from "lucide-react";
import { Badge } from "@/ui/badge";
import { Button, IconButton } from "@/ui/button";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Field, Input, Textarea } from "@/ui/field";
import { Select } from "@/ui/select";
import { Checkbox, RadioGroup, Switch } from "@/ui/choice";
import { ConfirmDialog, Menu, Modal } from "@/ui/overlay";
import { Banner, EmptyState } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import {
  closeSurveyAction, deleteQuestionAction, deleteSurveyAction, launchSurveyAction, moveQuestionAction, saveQuestionAction, saveSurveyAction,
} from "@/app/(app)/engage/surveys/actions";
import type { Audience, SurveyDetail } from "@/server/modules/surveys/service";
import { CHOICE_TYPES, QUESTION_LABEL, QUESTION_TYPES, RECURRENCES, type Question, type QuestionType, type Recurrence } from "@/server/modules/surveys/rules";

type Opt = { id: string; name: string };
const REPEAT: Record<Recurrence, string> = { none: "Doesn't repeat", weekly: "Every week", monthly: "Every month", quarterly: "Every quarter" };

/** Survey settings and questions. Questions lock once the survey goes live, so every round's answers compare. */
export function SurveyBuilder({ s, departments, locations, today }: { s: SurveyDetail; departments: Opt[]; locations: Opt[]; today: string }) {
  const router = useRouter();
  const [editing, setEditing] = React.useState<Question | "new" | null>(null);
  const [pending, start] = React.useTransition();
  const draft = s.status === "draft";
  const launch = () => start(async () => {
    const r = await launchSurveyAction(s.id);
    if (!r.ok) { toast.error(r.error); return; }
    toast.success(r.data?.scheduled ? `Scheduled. It opens on ${r.data.scheduled}.` : "Survey is live. Everyone in the audience has been told.");
  });
  const move = (id: string, dir: "up" | "down") => start(async () => { const r = await moveQuestionAction(s.id, id, dir); if (!r.ok) toast.error(r.error); });
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={s.status === "live" ? "accent" : s.status === "closed" ? "success" : s.schedule.startOn ? "warning" : "neutral"} size="md">
          {s.status === "live" ? `Live${s.schedule.recurrence !== "none" ? ` · round ${s.schedule.round}` : ""}` : s.status === "closed" ? "Closed" : s.schedule.startOn ? `Scheduled for ${s.schedule.startOn}` : "Draft"}
        </Badge>
        <span className="text-sm text-text-muted">{s.audienceSize} {s.audienceSize === 1 ? "person" : "people"} in the audience{s.status !== "draft" ? ` · ${s.responses} answered this round` : ""}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          {s.status !== "draft" && <Button asChild size="sm" variant="secondary"><Link href={`/engage/surveys/${s.id}/results`}><BarChart3 />Results</Link></Button>}
          {draft && <Button size="sm" loading={pending} onClick={launch} disabled={!s.questions.length}><Rocket />{s.schedule.startOn && s.schedule.startOn > today ? "Schedule" : "Launch now"}</Button>}
          {s.status === "live" && <ConfirmDialog title="Close this survey?" description="No more answers are taken. Results stay available." confirmLabel="Close survey" tone="primary"
            onConfirm={async () => { const r = await closeSurveyAction(s.id); if (r.ok) toast.success("Survey closed"); else toast.error(r.error); }}
            trigger={<Button size="sm" variant="secondary"><Square />Close</Button>} />}
          {draft && <ConfirmDialog title="Delete this draft?" description="This can't be undone." confirmLabel="Delete"
            onConfirm={async () => { const r = await deleteSurveyAction(s.id); if (r.ok) { toast.success("Draft deleted"); router.push("/engage/surveys"); } else toast.error(r.error); }}
            trigger={<IconButton size="icon-sm" variant="ghost" label="Delete draft"><Trash2 /></IconButton>} />}
        </div>
      </div>

      <Settings s={s} departments={departments} locations={locations} />

      <Card>
        <CardHeader title="Questions" description={draft ? "One question per screen on phones." : "Questions are locked while the survey is live or closed."}
          action={draft ? <Button size="sm" variant="secondary" onClick={() => setEditing("new")}><Plus />Question</Button> : <Lock className="size-4 text-text-muted" aria-label="Locked" />} />
        {s.questions.length === 0 ? <EmptyState compact title="No questions yet" description="Add at least one question to launch." /> : (
          <ol className="divide-y divide-border border-t border-border" aria-busy={pending || undefined}>
            {s.questions.map((q, i) => (
              <li key={q.id} className="flex items-start gap-3 px-5 py-3">
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-pill bg-surface-hover text-sm tabular">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-base font-medium">{q.prompt}{q.required && <span className="ml-0.5 text-danger" aria-label="required">*</span>}</p>
                  <p className="text-sm text-text-muted">{QUESTION_LABEL[q.type]}{q.options?.choices ? ` · ${q.options.choices.join(", ")}` : q.options?.max ? ` · 1–${q.options.max}` : ""}</p>
                </div>
                {draft && (
                  <Menu trigger={<IconButton size="icon-sm" label={`Actions for question ${i + 1}`}><MoreHorizontal /></IconButton>}
                    items={[
                      { label: "Edit", icon: <Pencil />, onSelect: () => setEditing(q) },
                      { label: "Move up", icon: <ArrowUp />, disabled: i === 0, onSelect: () => move(q.id, "up") },
                      { label: "Move down", icon: <ArrowDown />, disabled: i === s.questions.length - 1, onSelect: () => move(q.id, "down") },
                      "separator",
                      { label: "Delete", icon: <Trash2 />, danger: true, onSelect: async () => { const r = await deleteQuestionAction(s.id, q.id); if (r.ok) toast.success("Question removed"); else toast.error(r.error); } },
                    ]} />
                )}
              </li>
            ))}
          </ol>
        )}
      </Card>
      {editing && <QuestionDialog surveyId={s.id} q={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function Settings({ s, departments, locations }: { s: SurveyDetail; departments: Opt[]; locations: Opt[] }) {
  const live = s.status === "live", closed = s.status === "closed";
  const [title, setTitle] = React.useState(s.title);
  const [description, setDescription] = React.useState(s.description ?? "");
  const [anonymous, setAnonymous] = React.useState(s.anonymous);
  const [min, setMin] = React.useState(String(s.minResponses));
  const [aType, setAType] = React.useState<Audience["type"]>(s.audience.type);
  const [ids, setIds] = React.useState<string[]>(s.audience.type === "org" ? [] : s.audience.ids);
  const [startOn, setStartOn] = React.useState(s.schedule.startOn ?? "");
  const [endOn, setEndOn] = React.useState(s.schedule.endOn ?? "");
  const [recurrence, setRecurrence] = React.useState<Recurrence>(s.schedule.recurrence);
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const opts = aType === "departments" ? departments : aType === "locations" ? locations : [];
  const save = () => start(async () => {
    const n = Number(min);
    const r = await saveSurveyAction(s.id, {
      title, description: description || null, anonymous, minResponses: Number.isInteger(n) ? n : 0,
      audience: aType === "org" ? { type: "org" } : { type: aType, ids }, startOn: startOn || null, endOn: endOn || null, recurrence,
    });
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    setError(null); toast.success("Survey saved");
  });
  const err = (f: string) => (error?.field === f ? error.message : undefined);
  return (
    <Card>
      <CardHeader title="Settings" />
      <CardBody>
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
          {error && !["title", "minResponses"].includes(error.field ?? "") && <Banner tone="danger">{error.message}</Banner>}
          <Field label="Title" required error={err("title")}><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} disabled={closed} /></Field>
          <Field label="Introduction" help="Optional. Shown before the first question."><Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} disabled={closed} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Switch label="Anonymous answers" checked={anonymous} onCheckedChange={setAnonymous} disabled={live || closed} />
              <p className="text-sm text-text-muted">{anonymous ? "Names are never stored with answers. Results show only for groups with enough answers." : "Results show who answered what."}</p>
            </div>
            {anonymous && <Field label="Minimum answers to show results" error={err("minResponses")}><Input type="number" inputMode="numeric" min={3} max={50} value={min} onChange={(e) => setMin(e.target.value)} disabled={closed} /></Field>}
          </div>
          <fieldset className="flex flex-col gap-2" disabled={live || closed}>
            <legend className="mb-1 text-sm font-medium">Who it&apos;s for</legend>
            <RadioGroup value={aType} onValueChange={(v) => { setAType(v as Audience["type"]); setIds([]); }} disabled={live || closed}
              options={[{ value: "org", label: "Everyone" }, { value: "departments", label: "Some departments" }, { value: "locations", label: "Some locations" }]} />
            {aType !== "org" && (
              <div className="grid max-h-40 grid-cols-1 gap-2 overflow-y-auto rounded-md border border-border p-3 sm:grid-cols-2">
                {opts.map((o) => <Checkbox key={o.id} label={o.name} checked={ids.includes(o.id)} disabled={live || closed} onCheckedChange={(c) => setIds((x) => (c ? [...x, o.id] : x.filter((y) => y !== o.id)))} />)}
              </div>
            )}
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Opens on" help={live || closed ? undefined : "Leave empty to open when you launch."}><Input type="date" value={startOn} onChange={(e) => setStartOn(e.target.value)} disabled={live || closed} /></Field>
            <Field label="Closes on" help="Optional"><Input type="date" value={endOn} onChange={(e) => setEndOn(e.target.value)} disabled={closed} /></Field>
            <Field label="Repeats" help={recurrence !== "none" ? "A pulse: everyone answers again each round." : undefined}>
              <Select value={recurrence} onValueChange={(v) => setRecurrence(v as Recurrence)} options={RECURRENCES.map((r) => ({ value: r, label: REPEAT[r] }))} disabled={closed} />
            </Field>
          </div>
          {!closed && <div><Button type="submit" variant="secondary" loading={pending}>Save settings</Button></div>}
        </form>
      </CardBody>
    </Card>
  );
}

function QuestionDialog({ surveyId, q, onClose }: { surveyId: string; q: Question | null; onClose: () => void }) {
  const [type, setType] = React.useState<QuestionType>(q?.type ?? "single");
  const [prompt, setPrompt] = React.useState(q?.prompt ?? "");
  const [required, setRequired] = React.useState(q?.required ?? true);
  const [choices, setChoices] = React.useState<string[]>(q?.options?.choices ?? ["", ""]);
  const [max, setMax] = React.useState(String(q?.options?.max ?? 5));
  const [left, setLeft] = React.useState(q?.options?.left ?? "");
  const [right, setRight] = React.useState(q?.options?.right ?? "");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  const isChoice = CHOICE_TYPES.includes(type);
  const save = () => start(async () => {
    const options = isChoice ? { choices } : type === "opinion_scale" ? { max: Number(max), left, right } : type === "rating" ? { max: Number(max) } : null;
    const r = await saveQuestionAction(surveyId, q?.id ?? null, { type, prompt, required, options });
    if (!r.ok) { setError(r.error); return; }
    toast.success(q ? "Question updated" : "Question added"); onClose();
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title={q ? "Edit question" : "Add question"}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={save}>Save</Button></>}>
      <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); save(); }}>
        {error && <Banner tone="danger">{error}</Banner>}
        <Field label="Type"><Select value={type} onValueChange={(v) => { setType(v as QuestionType); if (v === "opinion_scale" && ![5, 7, 10].includes(Number(max))) setMax("5"); }} options={QUESTION_TYPES.map((t) => ({ value: t, label: QUESTION_LABEL[t] }))} /></Field>
        <Field label="Question" required><Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={500} rows={2} autoFocus /></Field>
        {isChoice && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Options</legend>
            {choices.map((c, i) => (
              <div key={i} className="flex gap-2">
                <Input value={c} onChange={(e) => setChoices((x) => x.map((y, j) => (j === i ? e.target.value : y)))} maxLength={200} aria-label={`Option ${i + 1}`} placeholder={`Option ${i + 1}`} />
                <IconButton size="icon" label={`Remove option ${i + 1}`} disabled={choices.length <= 2} onClick={() => setChoices((x) => x.filter((_, j) => j !== i))}><X /></IconButton>
              </div>
            ))}
            {choices.length < 20 && <div><Button size="sm" variant="ghost" onClick={() => setChoices((x) => [...x, ""])}><Plus />Add option</Button></div>}
          </fieldset>
        )}
        {type === "opinion_scale" && (
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Points"><Select value={max} onValueChange={setMax} options={["5", "7", "10"].map((v) => ({ value: v, label: v }))} /></Field>
            <Field label="Low end label"><Input value={left} onChange={(e) => setLeft(e.target.value)} placeholder="Strongly disagree" maxLength={60} /></Field>
            <Field label="High end label"><Input value={right} onChange={(e) => setRight(e.target.value)} placeholder="Strongly agree" maxLength={60} /></Field>
          </div>
        )}
        {type === "rating" && <Field label="Stars"><Select value={max} onValueChange={setMax} options={["3", "4", "5", "6", "7", "8", "9", "10"].map((v) => ({ value: v, label: v }))} /></Field>}
        {type === "nps" && <p className="text-sm text-text-muted">People pick 0 to 10. The results show an eNPS score: % of 9–10 minus % of 0–6.</p>}
        <Checkbox label="Answer required" checked={required} onCheckedChange={(c) => setRequired(!!c)} />
      </form>
    </Modal>
  );
}
