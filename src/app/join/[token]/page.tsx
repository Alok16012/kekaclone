import type { Metadata } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { Rocket } from "lucide-react";
import { withTenant } from "@/server/db";
import { currentSubdomain, resolveTenant } from "@/server/auth/session";
import { portalView } from "@/server/modules/onboarding/service";
import { todayIn } from "@/lib/dates";
import { Card, CardHeader } from "@/ui/card";
import { Progress, Skeleton } from "@/ui/feedback";
import { TaskItem } from "@/features/onboarding/task-item";

export const metadata: Metadata = { title: "Your first steps", robots: { index: false, follow: false } };

const fmt = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

/**
 * Joiner portal (public): the company comes from the subdomain, then the token is looked up inside that company only.
 * A wrong, expired or replaced token gets the same answer as an unknown company.
 */
async function Body({ params }: { params: PageProps<"/join/[token]">["params"] }) {
  await connection();
  const { token } = await params;
  const tenant = await resolveTenant(await currentSubdomain());
  const v = tenant ? await withTenant(tenant.id, (tx) => portalView(tx, tenant, token, todayIn())) : null;
  if (!v) {
    return (
      <Card className="p-6 text-center sm:p-8">
        <h1 className="text-xl font-semibold">This link doesn&apos;t work anymore</h1>
        <p className="mt-2 text-base text-text-muted">Links to your joining checklist expire after 14 days or when HR sends a new one. Ask your HR contact for a fresh link.</p>
      </Card>
    );
  }
  const open = v.tasks.filter((t) => t.status === "open").length;
  return (
    <div className="flex flex-col gap-4">
      <Card className="p-6 sm:p-8">
        <p className="text-sm text-text-muted">{v.company}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Welcome, {v.name.split(" ")[0]}</h1>
        <p className="mt-1 text-base text-text-muted">Your first day is {fmt(v.joining_date)}. {open ? "Here's what we need from you before and after it." : "You've finished everything we asked for. See you soon!"}</p>
        <div className="mt-4"><div className="mb-1 flex justify-between text-sm text-text-muted"><span>{v.progress.done} of {v.progress.total} done</span><span className="tabular">{v.progress.pct}%</span></div>
          <Progress value={v.progress.done} max={Math.max(1, v.progress.total)} label="Your checklist progress" /></div>
      </Card>
      <Card>
        <CardHeader title={<span className="inline-flex items-center gap-2"><Rocket className="size-4 text-accent-text" aria-hidden />Your checklist</span>} description="Details you share go to HR for a quick check." />
        {v.tasks.length === 0 ? <p className="px-5 pb-5 text-base text-text-muted">Nothing for you to do right now.</p> : (
          <ul className="divide-y divide-border border-t border-border">{v.tasks.map((t) => <TaskItem key={t.id} task={t} mode={{ kind: "portal", token }} showAssignee={false} />)}</ul>
        )}
      </Card>
      <p className="text-center text-sm text-text-muted">This page is private to you. Don&apos;t share the link.</p>
    </div>
  );
}

export default function JoinPage(props: PageProps<"/join/[token]">) {
  return (
    <div className="min-h-dvh bg-canvas px-4 py-10">
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-8 flex items-center gap-2.5">
          <span aria-hidden className="flex size-9 items-center justify-center rounded-md bg-accent text-md font-bold text-on-accent">e</span>
          <span className="text-xl font-semibold">erp</span>
        </div>
        <Suspense fallback={<Card className="flex flex-col gap-4 p-8" aria-busy aria-label="Loading"><Skeleton className="h-7 w-2/3" /><Skeleton className="h-4" /><Skeleton className="h-24" /></Card>}>
          <Body params={props.params} />
        </Suspense>
      </div>
    </div>
  );
}
