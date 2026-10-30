import Link from "next/link";
import { ArrowRight, CheckCircle2, Circle, MinusCircle, Rocket } from "lucide-react";
import { Button } from "@/ui/button";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Progress } from "@/ui/feedback";
import { cn } from "@/lib/cn";
import { SETUP_STEPS } from "@/server/modules/setup/rules";
import type { SetupSummary } from "@/server/modules/setup/service";

/** Dashboard card for Global admins until company setup is finished. */
export function SetupChecklist({ summary }: { summary: SetupSummary }) {
  const { state, progress, next } = summary;
  return (
    <Card className="mb-6">
      <CardHeader title={<span className="inline-flex items-center gap-2"><Rocket className="size-4 text-accent-text" aria-hidden />Finish setting up your company</span>}
        description={`${progress.done} of ${progress.total} steps done. You can come back to any step at any time.`}
        action={<Button asChild size="sm"><Link href={`/setup?step=${next}`}>{state.status === "pending" ? "Start setup" : "Continue setup"}<ArrowRight /></Link></Button>} />
      <CardBody className="flex flex-col gap-4">
        <Progress value={progress.done} max={progress.total} label="Setup progress" />
        <ol className="grid gap-1 sm:grid-cols-2 lg:grid-cols-4">
          {SETUP_STEPS.map((s) => {
            const st = state.steps[s.key]?.status;
            const Icon = st === "done" ? CheckCircle2 : st === "skipped" ? MinusCircle : Circle;
            return (
              <li key={s.key}>
                <Link href={`/setup?step=${s.key}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-base hover:bg-surface-sunken">
                  <Icon className={cn("size-4 shrink-0", st === "done" ? "text-success-text" : "text-text-muted")} aria-hidden />
                  <span className={cn(st === "done" && "text-text-muted line-through decoration-1")}>{s.label}</span>
                  <span className="sr-only">{st === "done" ? "(done)" : st === "skipped" ? "(skipped)" : "(to do)"}</span>
                </Link>
              </li>
            );
          })}
        </ol>
      </CardBody>
    </Card>
  );
}
