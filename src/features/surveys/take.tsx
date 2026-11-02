"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, CheckCircle2, EyeOff, Send, Star } from "lucide-react";
import { Button } from "@/ui/button";
import { Card, CardBody } from "@/ui/card";
import { Input, Textarea, controlBase } from "@/ui/field";
import { Checkbox, RadioGroup } from "@/ui/choice";
import { Banner, EmptyState, Progress } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { cn } from "@/lib/cn";
import { submitSurveyAction } from "@/app/(app)/engage/surveys/actions";
import type { TakeView } from "@/server/modules/surveys/service";
import type { Answer, Question } from "@/server/modules/surveys/rules";

const subscribe = (cb: () => void) => { const m = window.matchMedia("(min-width: 640px)"); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); };
/** Wide screens show every question at once; phones get one question per screen. */
function useWide() {
  return React.useSyncExternalStore(subscribe, () => window.matchMedia("(min-width: 640px)").matches, () => true);
}

function Scale({ q, value, onChange, from, to }: { q: Question; value: Answer; onChange: (v: number) => void; from: number; to: number }) {
  const nums = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  return (
    <div>
      <div role="radiogroup" aria-label={q.prompt} className="flex flex-wrap gap-1.5">
        {nums.map((n) => (
          <button key={n} type="button" role="radio" aria-checked={value === n} onClick={() => onChange(n)}
            className={cn("size-10 rounded-md border border-border-input text-base font-medium tabular hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-focus",
              value === n && "border-accent bg-accent text-on-accent hover:bg-accent")}>{n}</button>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-sm text-text-muted">
        <span>{q.type === "nps" ? "Not at all likely" : q.options?.left}</span><span>{q.type === "nps" ? "Extremely likely" : q.options?.right}</span>
      </div>
    </div>
  );
}

function Stars({ q, value, onChange }: { q: Question; value: Answer; onChange: (v: number) => void }) {
  const max = q.options?.max ?? 5;
  return (
    <div role="radiogroup" aria-label={q.prompt} className="flex gap-1">
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
        <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} of ${max} stars`} onClick={() => onChange(n)}
          className="rounded-md p-1 focus-visible:outline-2 focus-visible:outline-focus">
          <Star className={cn("size-7", typeof value === "number" && n <= value ? "fill-warning text-warning" : "text-border-strong")} aria-hidden />
        </button>
      ))}
    </div>
  );
}

function AnswerInput({ q, value, onChange }: { q: Question; value: Answer; onChange: (v: Answer) => void }) {
  const id = `q-${q.id}`;
  const choices = q.options?.choices ?? [];
  switch (q.type) {
    case "short_text": return <Input id={id} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} maxLength={300} />;
    case "long_text": return <Textarea id={id} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} maxLength={3000} rows={4} />;
    case "dropdown": return (
      <select id={id} className={cn(controlBase, "h-9 px-3")} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">Choose…</option>{choices.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
    );
    case "single": return <RadioGroup aria-label={q.prompt} value={typeof value === "string" ? value : ""} onValueChange={onChange} options={choices.map((c) => ({ value: c, label: c }))} />;
    case "multi": {
      const arr = Array.isArray(value) ? value : [];
      return <div className="flex flex-col gap-2" role="group" aria-label={q.prompt}>{choices.map((c) => <Checkbox key={c} label={c} checked={arr.includes(c)} onCheckedChange={(on) => onChange(on ? [...arr, c] : arr.filter((x) => x !== c))} />)}</div>;
    }
    case "yes_no": return <RadioGroup aria-label={q.prompt} className="flex-row gap-6" value={typeof value === "string" ? value : ""} onValueChange={onChange} options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]} />;
    case "nps": return <Scale q={q} value={value} onChange={onChange} from={0} to={10} />;
    case "opinion_scale": return <Scale q={q} value={value} onChange={onChange} from={1} to={q.options?.max ?? 5} />;
    case "rating": return <Stars q={q} value={value} onChange={onChange} />;
    case "date": return <Input id={id} type="date" className="sm:w-56" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)} />;
  }
}

function QuestionBlock({ q, n, total, value, onChange, error }: { q: Question; n: number; total: number; value: Answer; onChange: (v: Answer) => void; error?: string }) {
  const labelled = ["short_text", "long_text", "dropdown", "date"].includes(q.type);
  return (
    <fieldset className="flex flex-col gap-3" aria-describedby={error ? `e-${q.id}` : undefined}>
      <legend className="mb-2 text-md font-medium">
        <span className="mr-2 text-sm text-text-muted tabular">{n}/{total}</span>
        {labelled ? <label htmlFor={`q-${q.id}`}>{q.prompt}</label> : q.prompt}
        {q.required ? <span aria-hidden className="ml-0.5 text-danger">*</span> : <span className="ml-1 text-sm font-normal text-text-muted">(optional)</span>}
      </legend>
      <AnswerInput q={q} value={value} onChange={onChange} />
      {error && <p id={`e-${q.id}`} role="alert" className="text-sm text-danger-text">{error}</p>}
    </fieldset>
  );
}

const missing = (q: Question, v: Answer | undefined) => q.required && (v == null || v === "" || (Array.isArray(v) && !v.length));

export function TakeSurvey({ s }: { s: TakeView }) {
  const wide = useWide();
  const [answers, setAnswers] = React.useState<Record<string, Answer>>({});
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [step, setStep] = React.useState(0);
  const [done, setDone] = React.useState(s.answered);
  const [pending, start] = React.useTransition();
  const set = (id: string, v: Answer) => { setAnswers((a) => ({ ...a, [id]: v })); setErrors((e) => { const n = { ...e }; delete n[id]; return n; }); };
  const total = s.questions.length;

  if (done) return (
    <Card><EmptyState icon={<CheckCircle2 />} title="Thanks for answering" description={s.anonymous ? "Your answers were saved without your name." : "Your answers were saved."} action={<Button asChild variant="secondary"><Link href="/me/surveys">Back to surveys</Link></Button>} /></Card>
  );
  if (s.status !== "live") return <Card><EmptyState title="This survey has closed" description="It isn't taking answers any more." /></Card>;

  const submit = () => {
    const errs: Record<string, string> = {};
    for (const q of s.questions) if (missing(q, answers[q.id])) errs[q.id] = "This question needs an answer.";
    if (Object.keys(errs).length) { setErrors(errs); const first = s.questions.findIndex((q) => errs[q.id]); setStep(first); toast.error("Some questions still need an answer."); return; }
    start(async () => {
      const r = await submitSurveyAction(s.id, answers);
      if (!r.ok) { if (r.field) { setErrors({ [r.field]: r.error }); setStep(Math.max(0, s.questions.findIndex((q) => q.id === r.field))); } toast.error(r.error); return; }
      setDone(true);
    });
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); if (wide || step === total - 1) submit(); else if (missing(s.questions[step], answers[s.questions[step].id])) setErrors({ [s.questions[step].id]: "This question needs an answer." }); else setStep(step + 1); }}
      className="flex flex-col gap-4">
      {s.anonymous && <Banner tone="info"><span className="inline-flex items-center gap-1.5"><EyeOff className="size-4" aria-hidden />Anonymous: your name isn&apos;t stored with your answers, and results only show for groups with enough answers.</span></Banner>}
      {s.description && <p className="text-base text-text-muted whitespace-pre-line">{s.description}</p>}
      {wide ? (
        <Card><CardBody className="flex flex-col gap-8 pt-5">
          {s.questions.map((q, i) => <QuestionBlock key={q.id} q={q} n={i + 1} total={total} value={answers[q.id] ?? null} onChange={(v) => set(q.id, v)} error={errors[q.id]} />)}
          <div><Button type="submit" loading={pending}><Send />Submit</Button></div>
        </CardBody></Card>
      ) : (
        <Card><CardBody className="flex flex-col gap-6 pt-5">
          <Progress value={step + 1} max={total} label={`Question ${step + 1} of ${total}`} />
          <QuestionBlock key={s.questions[step].id} q={s.questions[step]} n={step + 1} total={total} value={answers[s.questions[step].id] ?? null} onChange={(v) => set(s.questions[step].id, v)} error={errors[s.questions[step].id]} />
          <div className="flex justify-between gap-2">
            <Button variant="secondary" disabled={step === 0} onClick={() => setStep(step - 1)}><ArrowLeft />Back</Button>
            {step < total - 1 ? <Button type="submit">Next<ArrowRight /></Button> : <Button type="submit" loading={pending}><Send />Submit</Button>}
          </div>
        </CardBody></Card>
      )}
    </form>
  );
}
