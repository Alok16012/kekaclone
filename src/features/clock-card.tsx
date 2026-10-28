"use client";
import * as React from "react";
import { LogIn, LogOut } from "lucide-react";
import { Card } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { toast } from "@/ui/toast";
import type { TodayState } from "@/server/modules/attendance/service";
import { clockAction } from "@/app/(app)/actions";

const hms = (s: number) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, "0")).join(":");
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });

/**
 * Clock in/out with a live timer. Worked time = server total at `computedAt` + seconds elapsed since then while clocked in.
 * The first render uses only server values (no clock reads), so server and client HTML match.
 */
export function ClockCard({ state }: { state: TodayState }) {
  const [optimistic, setOptimistic] = React.useState<boolean | null>(null);
  const [pending, start] = React.useTransition();
  const [now, setNow] = React.useState<number | null>(null);
  const clockedIn = optimistic ?? state.clockedIn;

  React.useEffect(() => {
    if (!clockedIn) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [clockedIn]);

  const elapsed = state.clockedIn && now ? Math.max(0, Math.floor((now - Date.parse(state.computedAt)) / 1000)) : 0;
  const total = state.workedSeconds + elapsed;

  const click = () => {
    const expect = clockedIn ? "out" : "in";
    setOptimistic(!clockedIn);
    start(async () => {
      const r = await clockAction(expect);
      if (r.ok) toast.success(expect === "in" ? `Clocked in at ${time(r.data!.at)}` : `Clocked out at ${time(r.data!.at)}`);
      else toast.error(r.error);
      setOptimistic(null);
      setNow(null);
    });
  };
  const off = state.dayType === "weekly_off" || state.dayType === "holiday";
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm text-text-muted">
            {state.shift ? `${state.shift.name} shift · ${state.shift.start} – ${state.shift.end}` : off ? (state.dayType === "holiday" ? "Holiday today" : "Weekly off today") : "No shift today"}
          </p>
          <p className="mt-1 text-2xl font-semibold tabular">{hms(total)}</p>
          <p className="text-sm text-text-muted">
            {state.clockedIn && state.since ? `Clocked in since ${time(state.since)}` : state.firstIn ? `First in at ${time(state.firstIn)}` : "You haven't clocked in today"}
          </p>
        </div>
        <Badge tone={clockedIn ? "success" : "neutral"}>{clockedIn ? "Working" : "Not working"}</Badge>
      </div>
      <Button className="mt-4" size="lg" block variant={clockedIn ? "secondary" : "primary"} onClick={click} loading={pending}>
        {clockedIn ? <><LogOut />Clock out</> : <><LogIn />Clock in</>}
      </Button>
    </Card>
  );
}
