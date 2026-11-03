import Link from "next/link";
import { ArrowRight, CheckCircle2, ListChecks } from "lucide-react";
import { Avatar } from "@/ui/avatar";
import { Badge } from "@/ui/badge";
import { Card, CardHeader } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";
import type { MyTaskRow } from "@/server/modules/onboarding/service";
import { TASK_TYPE_LABEL } from "@/server/modules/onboarding/rules";

const fmt = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

function Row({ t }: { t: MyTaskRow }) {
  return (
    <li>
      <Link href={`/org/onboarding/${t.process_id}`} className="group flex items-center gap-3 px-5 py-3 hover:bg-surface-sunken">
        <Avatar name={t.subject.name} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2 text-base font-medium">
            <span className="truncate">{t.title}</span>
            {t.overdue && <Badge tone="danger">Overdue</Badge>}
            {t.status === "skipped" && <Badge>Skipped</Badge>}
          </span>
          <span className="block truncate text-sm text-text-muted">{[t.subject.name, TASK_TYPE_LABEL[t.type], t.due_date ? `Due ${fmt(t.due_date)}` : null].filter(Boolean).join(" · ")}</span>
        </span>
        <ArrowRight className="size-4 text-text-muted transition-transform group-hover:translate-x-0.5" aria-hidden />
      </Link>
    </li>
  );
}

/** Onboarding tasks the person owns for colleagues: open first (overdue flagged), then what they closed recently. */
export function MyTasks({ open, done }: { open: MyTaskRow[]; done: MyTaskRow[] }) {
  return (
    <>
      <Card>
        <CardHeader title="To do" description={open.length ? `${open.length} open` : undefined} />
        {open.length === 0 ? <EmptyState compact icon={<ListChecks />} title="You're all caught up" description="When someone joins and a task is yours, it shows up here." /> : (
          <ul className="divide-y divide-border border-t border-border">{open.map((t) => <Row key={t.id} t={t} />)}</ul>
        )}
      </Card>
      {done.length > 0 && (
        <Card>
          <CardHeader title="Recently closed" description="Last 30 days" />
          <ul className="divide-y divide-border border-t border-border">{done.map((t) => <Row key={t.id} t={t} />)}</ul>
        </Card>
      )}
      {open.length === 0 && done.length === 0 && <p className="flex items-center gap-2 text-sm text-text-muted"><CheckCircle2 className="size-4" aria-hidden />Tasks for new joiners are created when HR starts their onboarding.</p>}
    </>
  );
}
