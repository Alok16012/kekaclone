"use client";
import * as React from "react";
import { CalendarCheck } from "lucide-react";
import { Card } from "@/ui/card";
import { Button } from "@/ui/button";
import { Banner, EmptyState } from "@/ui/feedback";
import { cn } from "@/lib/cn";
import { pickSlotAction } from "@/app/p/actions";

type View = { firstName: string; job: string; company: string; mode: string; title: string | null; picked: string | null; status: string; slots: { index: number; label: string; past: boolean }[] };

/** S141: the candidate picks one of the offered interview times. */
export function SelfSchedule({ token, view }: { token: string; view: View }) {
  const [choice, setChoice] = React.useState<number | null>(null);
  const [booked, setBooked] = React.useState<string | null>(view.picked);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, start] = React.useTransition();
  const open = view.slots.filter((s) => !s.past);
  return (
    <Card className="p-6">
      <p className="text-sm text-text-muted">{view.company}</p>
      <h1 className="mt-1 text-2xl font-semibold">Hi {view.firstName}, pick a time for your interview</h1>
      <p className="mt-1 text-base text-text-muted">{view.title ?? "Interview"} for {view.job} · {view.mode}</p>
      {booked ? (
        <div role="status" className="mt-6 flex items-start gap-3 rounded-md bg-success-soft p-4 text-success-text">
          <CalendarCheck aria-hidden className="mt-0.5 size-5 shrink-0" /><div><p className="font-semibold">You&apos;re booked</p><p>{booked}. We&apos;ve emailed you the details.</p></div>
        </div>
      ) : open.length === 0 ? <EmptyState title="None of the times work any more" description="They've all passed. Reply to the email you got and the team will send new ones." /> : (
        <>
          <div role="radiogroup" aria-label="Interview times" className="mt-6 flex flex-col gap-2">
            {open.map((s) => (
              <button key={s.index} type="button" role="radio" aria-checked={choice === s.index} onClick={() => setChoice(s.index)}
                className={cn("rounded-md border px-4 py-3 text-left text-base", choice === s.index ? "border-accent bg-accent-soft font-semibold text-accent-text" : "border-border hover:border-border-strong")}>{s.label}</button>
            ))}
          </div>
          {error && <Banner tone="danger" className="mt-4">{error}</Banner>}
          <Button className="mt-5" size="lg" disabled={choice == null} loading={busy} onClick={() => start(async () => {
            setError(null);
            const r = await pickSlotAction(token, choice!);
            if (r.ok) setBooked(r.data!.when); else setError(r.error);
          })}>Confirm this time</Button>
        </>
      )}
    </Card>
  );
}
