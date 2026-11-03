"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Award, CheckCircle2, Circle, ExternalLink, FileText, HelpCircle, PlayCircle, BookOpenText, ChevronRight } from "lucide-react";
import { Card, CardHeader } from "@/ui/card";
import { Button } from "@/ui/button";
import { Badge, StatusChip } from "@/ui/badge";
import { RadioGroup } from "@/ui/choice";
import { Banner, EmptyState, Progress } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { completeModuleAction, submitQuizAction } from "@/app/(app)/learn/actions";
import { MODULE_KIND_LABEL, STATE_LABEL, type EnrollmentState, type ModuleKind } from "@/server/modules/learn/rules";
import type { Player as PlayerData, PlayerModule } from "@/server/modules/learn/service";
import { cn } from "@/lib/cn";

const ICON: Record<ModuleKind, React.ComponentType<{ className?: string }>> = { video: PlayCircle, document: FileText, text: BookOpenText, quiz: HelpCircle, link: ExternalLink };
const CHIP: Record<EnrollmentState, "draft" | "live" | "completed" | "overdue"> = { not_started: "draft", in_progress: "live", completed: "completed", overdue: "overdue" };
const fmt = (d: string | null) => (d ? new Date(d.slice(0, 10) + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : null);

/** S170: module list on the left, the current module on the right; mark done or pass the quiz to move on. */
export function Player({ data, preview }: { data: PlayerData; preview: boolean }) {
  const router = useRouter();
  const [currentId, setCurrentId] = React.useState<string | null>(data.next_module_id ?? data.modules[0]?.id ?? null);
  const current = data.modules.find((m) => m.id === currentId) ?? data.modules[0];
  const [busy, start] = React.useTransition();
  const done = data.modules.filter((m) => m.done_at).length;
  const idx = data.modules.findIndex((m) => m.id === current?.id);
  const next = data.modules[idx + 1];

  const complete = (m: PlayerModule) => start(async () => {
    const r = await completeModuleAction(data.course.id, m.id);
    if (!r.ok) { toast.error(r.error); return; }
    if (r.data?.completed) toast.success("Course completed", { description: data.course.certificate ? "Your certificate is ready on My learning." : undefined });
    else toast.success("Marked as done");
    if (next) setCurrentId(next.id);
    router.refresh();
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="ghost" size="sm"><Link href={preview ? "/learn/admin" : "/me/learn"}><ArrowLeft />{preview ? "Back to courses" : "My learning"}</Link></Button>
        <div className="ml-auto flex items-center gap-2">
          {preview ? <Badge tone="warning">Admin preview</Badge> : <StatusChip status={CHIP[data.enrollment.state]} label={STATE_LABEL[data.enrollment.state]} />}
          {data.enrollment.certificate_file_id && <Button asChild size="sm" variant="soft"><a href={`/learn/files/${data.enrollment.certificate_file_id}`} target="_blank" rel="noopener"><Award />Certificate</a></Button>}
        </div>
      </div>
      {!preview && data.enrollment.due_date && !data.enrollment.completed_at && (
        <Banner tone={data.enrollment.state === "overdue" ? "warning" : "info"} title={data.enrollment.state === "overdue" ? `This was due on ${fmt(data.enrollment.due_date)}` : `Due by ${fmt(data.enrollment.due_date)}`} />
      )}
      <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
        <Card className="h-fit">
          <div className="px-5 py-4">
            <h2 className="text-base font-semibold">{data.course.title}</h2>
            {data.course.description && <p className="mt-1 text-sm text-text-muted">{data.course.description}</p>}
            {!preview && <div className="mt-3"><Progress value={data.enrollment.percent} label={`${Math.round(data.enrollment.percent)}% done`} tone={data.enrollment.completed_at ? "success" : "accent"} /><p className="mt-1 text-xs text-text-muted">{done} of {data.modules.length} modules done</p></div>}
          </div>
          <nav aria-label="Modules">
            <ol className="divide-y divide-border border-t border-border">
              {data.modules.map((m, i) => {
                const Icon = ICON[m.kind];
                const active = m.id === current?.id;
                return (
                  <li key={m.id}>
                    <button type="button" onClick={() => setCurrentId(m.id)} aria-current={active ? "step" : undefined}
                      className={cn("flex w-full items-center gap-3 px-5 py-2.5 text-left text-base hover:bg-surface-hover", active && "bg-sidebar-active text-sidebar-active-text")}>
                      {m.done_at ? <CheckCircle2 className="size-4 shrink-0 text-success-text" aria-label="Done" /> : <Circle className="size-4 shrink-0 text-text-muted" aria-hidden />}
                      <span className="min-w-0 flex-1"><span className="block truncate">{i + 1}. {m.title}</span><span className="flex items-center gap-1 text-xs text-text-muted"><Icon className="size-3" aria-hidden />{MODULE_KIND_LABEL[m.kind]}</span></span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
        </Card>
        <div className="min-w-0">
          {!current ? <Card><EmptyState icon={<BookOpenText />} title="This course has no modules yet" /></Card> : (
            <Card>
              <CardHeader title={current.title} description={`Module ${idx + 1} of ${data.modules.length} · ${MODULE_KIND_LABEL[current.kind]}`} action={current.done_at ? <Badge tone="success"><CheckCircle2 />Done</Badge> : undefined} />
              <div className="px-5 pb-5">
                <ModuleBody m={current} courseId={data.course.id} preview={preview} enrolled={!!data.enrollment.id} onDone={() => { if (next) setCurrentId(next.id); router.refresh(); }} />
                {current.kind !== "quiz" && !preview && data.enrollment.id && (
                  <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border pt-4">
                    {!current.done_at ? <Button onClick={() => complete(current)} loading={busy}><CheckCircle2 />Mark as done</Button> : next ? <Button onClick={() => setCurrentId(next.id)}>Next module<ChevronRight /></Button> : <p className="text-sm text-text-muted">That was the last module.</p>}
                  </div>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

function ModuleBody({ m, courseId, preview, enrolled, onDone }: { m: PlayerModule; courseId: string; preview: boolean; enrolled: boolean; onDone: () => void }) {
  if (m.kind === "video") {
    if (!m.video) return <p className="text-text-muted">No video attached.</p>;
    return m.video.kind === "iframe"
      ? <div className="aspect-video overflow-hidden rounded-md bg-surface-sunken"><iframe src={m.video.src} title={m.title} className="size-full" allow="accelerometer; encrypted-media; picture-in-picture" allowFullScreen sandbox="allow-scripts allow-same-origin allow-presentation" referrerPolicy="strict-origin-when-cross-origin" /></div>
      : <video controls preload="metadata" className="w-full rounded-md bg-surface-sunken" src={m.video.src}><track kind="captions" />Your browser can&apos;t play this video. <a href={m.video.src}>Download it instead.</a></video>;
  }
  if (m.kind === "document") {
    if (!m.file) return <p className="text-text-muted">No document attached.</p>;
    return (
      <div className="flex flex-col gap-3">
        {m.file.mime === "application/pdf" && <iframe src={`/learn/files/${m.file.id}`} title={m.file.name} className="h-[60vh] w-full rounded-md border border-border" />}
        <Button asChild variant="secondary" className="self-start"><a href={`/learn/files/${m.file.id}${m.file.mime === "application/pdf" ? "" : "?download=1"}`} target="_blank" rel="noopener"><FileText />{m.file.mime === "application/pdf" ? "Open" : "Download"} {m.file.name}</a></Button>
      </div>
    );
  }
  if (m.kind === "text") return <div className="prose prose-sm max-w-none text-text [&_a]:text-accent-text [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:text-base [&_h3]:font-semibold [&_li]:ml-5 [&_ol]:list-decimal [&_p]:my-2 [&_ul]:list-disc" dangerouslySetInnerHTML={{ __html: m.html ?? "" }} />;
  if (m.kind === "link") return <Button asChild variant="secondary"><a href={m.link ?? "#"} target="_blank" rel="noopener noreferrer"><ExternalLink />Open {m.link?.replace(/^https?:\/\//, "").split("/")[0]}</a></Button>;
  return <Quiz m={m} courseId={courseId} disabled={preview || !enrolled} onDone={onDone} />;
}

function Quiz({ m, courseId, disabled, onDone }: { m: PlayerModule; courseId: string; disabled: boolean; onDone: () => void }) {
  const q = m.quiz!;
  const [answers, setAnswers] = React.useState<(number | null)[]>(() => q.questions.map(() => null));
  const [result, setResult] = React.useState<{ score: number; total: number; pct: number; passed: boolean } | null>(null);
  const [busy, start] = React.useTransition();
  const submit = () => {
    if (answers.some((a) => a == null)) { toast.error("Answer every question first."); return; }
    start(async () => {
      const r = await submitQuizAction(courseId, m.id, answers);
      if (!r.ok || !r.data) { toast.error(r.ok ? "Something went wrong." : r.error); return; }
      setResult(r.data);
      if (r.data.passed) { toast.success(r.data.completed ? "Course completed" : "Quiz passed"); onDone(); }
    });
  };
  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-text-muted">{q.questions.length} {q.questions.length === 1 ? "question" : "questions"} · pass mark {q.pass_pct}%{m.best_attempt ? ` · your best so far ${m.best_attempt.pct}%` : ""}</p>
      {m.done_at && <Banner tone="success" title="You've passed this quiz">You can try again for a better score, but it&apos;s already counted.</Banner>}
      {result && !result.passed && <Banner tone="warning" title={`${result.score} of ${result.total} right (${result.pct}%)`}>Not quite the pass mark. Review the material and try again.</Banner>}
      {result?.passed && <Banner tone="success" title={`${result.score} of ${result.total} right (${result.pct}%)`}>Well done.</Banner>}
      <ol className="flex flex-col gap-5">
        {q.questions.map((qq, i) => (
          <li key={qq.id}>
            <p className="mb-2 text-base font-medium">{i + 1}. {qq.text}</p>
            <RadioGroup value={answers[i] == null ? "" : String(answers[i])} onValueChange={(v) => setAnswers((a) => a.map((x, j) => (j === i ? Number(v) : x)))} disabled={disabled}
              options={qq.options.map((o, j) => ({ value: String(j), label: o }))} />
          </li>
        ))}
      </ol>
      {!disabled && <Button onClick={submit} loading={busy} className="self-start">Submit answers</Button>}
      {disabled && <p className="text-sm text-text-muted">Quizzes can only be taken by enrolled learners.</p>}
    </div>
  );
}
