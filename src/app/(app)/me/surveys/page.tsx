import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, ClipboardList, EyeOff } from "lucide-react";
import { load } from "@/server/page-data";
import { mySurveys, processDueSurveys } from "@/server/modules/surveys/service";
import { PageHeader } from "@/ui/app-shell";
import { Badge } from "@/ui/badge";
import { Card, CardHeader } from "@/ui/card";
import { EmptyState } from "@/ui/feedback";

export const metadata: Metadata = { title: "Surveys" };

export default async function MySurveysPage() {
  const rows = await load(async (tx, actor) => { await processDueSurveys(tx); return mySurveys(tx, actor); });
  const open = rows.filter((r) => !r.answered), answered = rows.filter((r) => r.answered);
  return (
    <>
      <PageHeader title="Surveys" description="Tell HR how things are going. It takes a couple of minutes." />
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader title="Waiting for you" />
          {open.length === 0 ? <EmptyState compact icon={<ClipboardList />} title="No surveys waiting" description="When HR sends a survey, it shows up here and on Home." /> : (
            <ul className="divide-y divide-border border-t border-border">
              {open.map((s) => (
                <li key={s.id}>
                  <Link href={`/me/surveys/${s.id}`} className="group flex items-center gap-3 px-5 py-3 hover:bg-surface-sunken">
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2 text-base font-medium">{s.title}{s.anonymous && <Badge><EyeOff />Anonymous</Badge>}</span>
                      <span className="block text-sm text-text-muted">{s.questions} {s.questions === 1 ? "question" : "questions"}{s.endOn ? ` · closes ${s.endOn}` : ""}</span>
                    </span>
                    <ArrowRight className="size-4 text-text-muted transition-transform group-hover:translate-x-0.5" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {answered.length > 0 && (
          <Card>
            <CardHeader title="Answered" description="Surveys you've already done this round" />
            <ul className="divide-y divide-border border-t border-border">
              {answered.map((s) => <li key={s.id} className="px-5 py-3 text-base">{s.title}<span className="block text-sm text-text-muted">{s.recurrence !== "none" ? "You'll be asked again next round." : "Thanks!"}</span></li>)}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}
