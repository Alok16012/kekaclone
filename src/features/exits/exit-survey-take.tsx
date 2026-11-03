"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Send } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Button } from "@/ui/button";
import { Field, Textarea } from "@/ui/field";
import { RadioGroup } from "@/ui/choice";
import { Banner } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { submitExitSurveyAction } from "@/app/(app)/org/exits/actions";
import type { MyExitSurvey } from "@/server/modules/exits/survey";
import type { ExitAnswer } from "@/server/modules/exits/survey-rules";

const fmt = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** /me/exit-survey: the leaver answers once; afterwards the page shows what they sent. */
export function ExitSurveyTake({ survey }: { survey: MyExitSurvey }) {
  const router = useRouter();
  const [answers, setAnswers] = React.useState<Record<string, ExitAnswer>>(survey.answers);
  const [error, setError] = React.useState<{ message: string; field?: string } | null>(null);
  const [pending, start] = React.useTransition();
  const done = !!survey.submittedAt;
  const set = (id: string, v: ExitAnswer) => setAnswers((a) => ({ ...a, [id]: v }));
  const submit = () => start(async () => {
    setError(null);
    const r = await submitExitSurveyAction(answers);
    if (!r.ok) { setError({ message: r.error, field: r.field }); return; }
    toast.success("Thank you for your answers"); router.refresh();
  });
  return (
    <Card>
      <CardHeader title={done ? "Your answers" : "Before your last day"} description={done ? `Sent on ${new Date(survey.submittedAt!).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}. Thank you.` : `Your last working day is ${fmt(survey.lastWorkingDate)}. Please answer before then, while you can still sign in.`} />
      <CardBody className="flex flex-col gap-5">
        {done && <Banner tone="success" title="Thank you"><CheckCircle2 className="mr-1 inline size-4" aria-hidden />Your answers were sent to HR.</Banner>}
        {error && !error.field && <Banner tone="danger">{error.message}</Banner>}
        {survey.questions.length === 0 && <p className="text-base text-text-muted">There are no questions yet.</p>}
        {survey.questions.map((q, i) => {
          const v = answers[q.id];
          const err = error?.field === q.id ? error.message : undefined;
          const label = `${i + 1}. ${q.prompt}`;
          if (q.type === "text") return <Field key={q.id} label={label} required={q.required} error={err}><Textarea value={typeof v === "string" ? v : ""} onChange={(e) => set(q.id, e.target.value)} rows={3} maxLength={2000} disabled={done} /></Field>;
          if (q.type === "rating") return (
            <Field key={q.id} label={label} required={q.required} error={err} help="1 = poor, 5 = excellent">
              <div role="radiogroup" aria-label={q.prompt} className="flex gap-2">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} type="button" role="radio" aria-checked={v === n} disabled={done} onClick={() => set(q.id, n)}
                    className={`size-11 rounded-md border text-base font-medium tabular transition-colors ${v === n ? "border-accent bg-accent text-on-accent" : "border-border-input bg-surface hover:bg-surface-hover"} disabled:opacity-70`}>{n}</button>
                ))}
              </div>
            </Field>
          );
          if (q.type === "yes_no") return (
            <Field key={q.id} label={label} required={q.required} error={err}>
              <RadioGroup value={v === true ? "yes" : v === false ? "no" : ""} onValueChange={(x) => set(q.id, x === "yes")} disabled={done} options={[{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]} />
            </Field>
          );
          return (
            <Field key={q.id} label={label} required={q.required} error={err}>
              <RadioGroup value={typeof v === "string" ? v : ""} onValueChange={(x) => set(q.id, x)} disabled={done} options={q.options.map((o) => ({ value: o, label: o }))} />
            </Field>
          );
        })}
        {!done && survey.questions.length > 0 && <div><Button size="lg" loading={pending} onClick={submit}><Send />Send my answers</Button></div>}
      </CardBody>
    </Card>
  );
}
