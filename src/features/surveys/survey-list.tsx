"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BarChart3, ClipboardList, EyeOff, Plus, Repeat } from "lucide-react";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Card } from "@/ui/card";
import { Modal } from "@/ui/overlay";
import { EmptyState } from "@/ui/feedback";
import { Tabs, TabsContent, TabsList } from "@/ui/tabs";
import { toast } from "@/ui/toast";
import { cn } from "@/lib/cn";
import { createSurveyAction } from "@/app/(app)/engage/surveys/actions";
import type { SurveyListRow } from "@/server/modules/surveys/service";
import { STARTERS } from "@/server/modules/surveys/rules";

const fmt = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const REPEAT = { none: null, weekly: "Weekly", monthly: "Monthly", quarterly: "Quarterly" } as const;
const TONE = { draft: "neutral", scheduled: "warning", live: "accent", closed: "success" } as const;
const LABEL = { draft: "Draft", scheduled: "Scheduled", live: "Live", closed: "Closed" } as const;

/** Surveys by state, with response rate for the current round, and a "New survey" picker of starting points. */
export function SurveyList({ rows }: { rows: SurveyListRow[] }) {
  const [creating, setCreating] = React.useState(false);
  const tabs = (["draft", "live", "closed"] as const).map((k) => ({ k, rows: rows.filter((r) => (k === "draft" ? r.status === "draft" || r.status === "scheduled" : r.status === k)) }));
  return (
    <>
      <Tabs defaultValue={tabs[1].rows.length ? "live" : "draft"}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <TabsList items={tabs.map((t) => ({ value: t.k, label: t.k === "draft" ? "Drafts" : LABEL[t.k], count: t.rows.length }))} />
          <Button size="sm" onClick={() => setCreating(true)}><Plus />New survey</Button>
        </div>
        {tabs.map((t) => (
          <TabsContent key={t.k} value={t.k}>
            {t.rows.length === 0 ? (
              <Card><EmptyState icon={<ClipboardList />} title={t.k === "draft" ? "No drafts" : t.k === "live" ? "No surveys running" : "No closed surveys yet"}
                description={t.k === "draft" ? "Start from a blank survey or a ready-made pulse." : undefined} action={t.k === "draft" ? <Button size="sm" variant="secondary" onClick={() => setCreating(true)}><Plus />New survey</Button> : undefined} /></Card>
            ) : (
              <Card>
                <ul className="divide-y divide-border">
                  {t.rows.map((r) => (
                    <li key={r.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-2 text-base font-medium">
                          <Link href={`/engage/surveys/${r.id}`} className="truncate hover:underline">{r.title}</Link>
                          <Badge tone={TONE[r.status]}>{LABEL[r.status]}</Badge>
                          {r.anonymous && <Badge><EyeOff />Anonymous</Badge>}
                          {REPEAT[r.recurrence] && <Badge><Repeat />{REPEAT[r.recurrence]}{r.status === "live" || r.status === "closed" ? ` · round ${r.round}` : ""}</Badge>}
                        </p>
                        <p className="text-sm text-text-muted">
                          {[`${r.questions} ${r.questions === 1 ? "question" : "questions"}`, r.status === "scheduled" && r.startOn ? `Opens ${fmt(r.startOn)}` : null, r.endOn ? `Closes ${fmt(r.endOn)}` : null].filter(Boolean).join(" · ")}
                        </p>
                      </div>
                      {(r.status === "live" || r.status === "closed") && (
                        <div className="flex items-center gap-3">
                          <span className="text-sm text-text-muted tabular">{r.responses} of {r.audience} answered{r.audience ? ` (${Math.round((r.responses / r.audience) * 100)}%)` : ""}</span>
                          <Button asChild size="sm" variant="secondary"><Link href={`/engage/surveys/${r.id}/results`}><BarChart3 />Results</Link></Button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </TabsContent>
        ))}
      </Tabs>
      {creating && <NewSurvey onClose={() => setCreating(false)} />}
    </>
  );
}

function NewSurvey({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [pick, setPick] = React.useState("blank");
  const [pending, start] = React.useTransition();
  const go = () => start(async () => {
    const r = await createSurveyAction(pick);
    if (!r.ok) { toast.error(r.error); return; }
    router.push(`/engage/surveys/${r.data!.id}`);
  });
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} title="New survey" description="Pick a starting point. You can change everything before it goes live."
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={pending} onClick={go}>Create draft</Button></>}>
      <div role="radiogroup" aria-label="Starting point" className="grid gap-3 sm:grid-cols-2">
        {STARTERS.map((s) => (
          <button key={s.key} type="button" role="radio" aria-checked={pick === s.key} onClick={() => setPick(s.key)}
            className={cn("rounded-lg border border-border p-4 text-left transition-colors hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-focus", pick === s.key && "border-accent bg-accent-soft/40")}>
            <span className="block text-base font-medium">{s.key === "blank" ? "Blank survey" : s.title}</span>
            <span className="mt-1 block text-sm text-text-muted">{s.key === "blank" ? "Start with no questions." : `${s.questions.length} questions${s.anonymous ? " · anonymous" : ""}${s.recurrence !== "none" ? ` · repeats ${s.recurrence}` : ""}`}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
