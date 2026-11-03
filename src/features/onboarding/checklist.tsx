import { Rocket } from "lucide-react";
import { Card, CardHeader } from "@/ui/card";
import { Progress } from "@/ui/feedback";
import type { TaskView } from "@/server/modules/onboarding/service";
import { TaskItem } from "./task-item";

type Data = { status: string; joining_date: string; tasks: TaskView[]; progress: { total: number; done: number; overdue: number; pct: number } };

/** The joiner's own onboarding tasks (Home, My tasks, their profile). Each task has its own control. */
export function OnboardingChecklist({ data, title = "Your onboarding", compact }: { data: Data; title?: string; compact?: boolean }) {
  const open = data.tasks.filter((t) => t.status === "open");
  const shown = compact ? open.slice(0, 4) : data.tasks;
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2"><Rocket className="size-4 text-accent-text" aria-hidden />{title}</span>}
        description={data.status === "completed" || open.length === 0 ? "All done. Welcome aboard!" : `${data.progress.done} of ${data.progress.total} done${data.progress.overdue ? ` · ${data.progress.overdue} overdue` : ""}`} />
      <div className="px-5 pb-3"><Progress value={data.progress.done} max={Math.max(1, data.progress.total)} label="Your onboarding progress" tone={data.progress.overdue ? "warning" : "accent"} /></div>
      {shown.length > 0 && <ul className="divide-y divide-border border-t border-border">{shown.map((t) => <TaskItem key={t.id} task={t} showAssignee={false} />)}</ul>}
      {compact && open.length > shown.length && <p className="border-t border-border px-5 py-3 text-sm text-text-muted">and {open.length - shown.length} more in My tasks</p>}
    </Card>
  );
}
