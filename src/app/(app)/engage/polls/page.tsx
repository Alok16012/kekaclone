import type { Metadata } from "next";
import { ChartBar, EyeOff, Users } from "lucide-react";
import { load } from "@/server/page-data";
import * as engage from "@/server/modules/engage/service";
import { PageHeader } from "@/ui/app-shell";
import { Badge, StatusChip } from "@/ui/badge";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { EmptyState, Progress } from "@/ui/feedback";
import { EngageNav, NoAccess } from "@/features/engage/engage-nav";

export const metadata: Metadata = { title: "Poll results" };

const fmt = (iso: string) => new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export default async function PollsPage() {
  const polls = await load(async (tx, actor) => (engage.announceScope(actor) ? engage.pollsAdmin(tx, actor) : null));
  return (
    <>
      <PageHeader title="Poll results" description="How people voted in polls on the Home wall." />
      {!polls ? <NoAccess /> : (
        <>
          <EngageNav active="polls" />
          {polls.length === 0 ? (
            <Card><EmptyState icon={<ChartBar />} title="No polls yet" description="Anyone can start a poll from the Home wall. Results show up here." /></Card>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {polls.map((p) => (
                <Card key={p.id}>
                  <CardHeader title={p.question} description={`${p.author} · ${fmt(p.publishedAt)}`}
                    action={<StatusChip status={p.closed ? "completed" : "live"} label={p.closed ? "Closed" : "Open"} />} />
                  <CardBody className="flex flex-col gap-4">
                    <p className="flex flex-wrap items-center gap-2 text-sm text-text-muted">
                      <span className="inline-flex items-center gap-1"><Users className="size-4" aria-hidden />{p.voters} of {p.audienceSize} voted</span>
                      {p.endsAt && <span>· {p.closed ? "closed" : "closes"} {fmt(p.endsAt)}</span>}
                      {p.multiple && <Badge>Multiple choice</Badge>}
                      {p.anonymous && <Badge><EyeOff aria-hidden />Anonymous</Badge>}
                    </p>
                    <ul className="flex flex-col gap-3">
                      {p.options.map((o) => (
                        <li key={o.id}>
                          <div className="mb-1 flex items-baseline justify-between gap-3 text-base">
                            <span className="min-w-0 break-words">{o.label}</span>
                            <span className="shrink-0 tabular text-text-muted"><span className="font-semibold text-text">{o.pct}%</span> · {o.votes}</span>
                          </div>
                          <Progress value={o.pct} label={`${o.label}: ${o.pct}%`} />
                          {o.voterNames && o.voterNames.length > 0 && <p className="mt-1 text-sm text-text-muted">{o.voterNames.join(", ")}</p>}
                        </li>
                      ))}
                    </ul>
                  </CardBody>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
