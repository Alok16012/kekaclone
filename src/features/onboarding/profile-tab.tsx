import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card, CardHeader } from "@/ui/card";
import { EmptyState, Progress } from "@/ui/feedback";
import type { ProcessDetail } from "@/server/modules/onboarding/service";
import { TaskItem } from "./task-item";

const STATUS = { in_progress: { label: "In progress", tone: "accent" }, completed: { label: "Completed", tone: "success" }, cancelled: { label: "Cancelled", tone: "neutral" } } as const;

/** Onboarding on a profile: progress and the checklist (the person sees their own tasks; HR and the manager see all). */
export function ProfileOnboarding({ d, self }: { d: ProcessDetail; self: boolean }) {
  return (
    <Card>
      <CardHeader title={<span className="inline-flex items-center gap-2">Onboarding <Badge tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Badge></span>}
        description={`${d.progress.done} of ${d.progress.total} done${d.progress.overdue ? ` · ${d.progress.overdue} overdue` : ""}${d.template ? ` · ${d.template}` : ""}`}
        action={!self ? <Button asChild size="sm" variant="secondary"><Link href={`/org/onboarding/${d.id}`}>Open<ArrowRight /></Link></Button> : undefined} />
      <div className="px-5 pb-3"><Progress value={d.progress.done} max={Math.max(1, d.progress.total)} label="Onboarding progress" /></div>
      {d.tasks.length === 0 ? <EmptyState compact title="No tasks here" /> : (
        <ul className="divide-y divide-border border-t border-border">{d.tasks.map((t) => <TaskItem key={t.id} task={t} showAssignee={!self} />)}</ul>
      )}
    </Card>
  );
}
