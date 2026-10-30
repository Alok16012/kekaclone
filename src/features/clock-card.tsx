"use client";
import * as React from "react";
import { House, LogIn, LogOut, MapPin, MapPinOff } from "lucide-react";
import { Card } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Field, Input } from "@/ui/field";
import { Banner } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import type { TodayState } from "@/server/modules/attendance/service";
import { punchAction } from "@/app/(app)/me/attendance/actions";

const hms = (s: number) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, "0")).join(":");
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" });

type Geo = { lat: number; lng: number; accuracy: number };
type GeoProblem = { kind: "denied" | "unavailable" | "timeout" | "unsupported" | "outside"; message: string };

/** Asks the browser for the current position (only ever from a click). */
function locate(): Promise<Geo> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return reject({ kind: "unsupported" });
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject({ kind: e.code === e.PERMISSION_DENIED ? "denied" : e.code === e.TIMEOUT ? "timeout" : "unavailable" }),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  });
}

const GEO_COPY: Record<Exclude<GeoProblem["kind"], "outside">, string> = {
  denied: "Location is blocked for this site. Allow location in your browser's site settings (the icon next to the address bar), then try again.",
  unavailable: "We couldn't get your location. Turn on location services on your device and try again.",
  timeout: "Finding your location took too long. Move closer to a window or turn on Wi-Fi, then try again.",
  unsupported: "This browser can't share your location. Try a different browser, or clock in from the office network.",
};

/**
 * Clock in/out with a live timer. Worked time = server total at `computedAt` + seconds elapsed since then while clocked in.
 * The first render uses only server values (no clock reads), so server and client HTML match.
 * Location is asked for only when the server says this punch needs it (off the office network under a geofence policy).
 */
export function ClockCard({ state }: { state: TodayState }) {
  const [optimistic, setOptimistic] = React.useState<boolean | null>(null);
  const [pending, start] = React.useTransition();
  const [now, setNow] = React.useState<number | null>(null);
  const [locating, setLocating] = React.useState(false);
  const [geoProblem, setGeoProblem] = React.useState<GeoProblem | null>(null);
  const [comment, setComment] = React.useState("");
  const [commentError, setCommentError] = React.useState<string | null>(null);
  const clockedIn = optimistic ?? state.clockedIn;
  const cap = state.capture;

  React.useEffect(() => {
    if (!clockedIn) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [clockedIn]);

  const elapsed = state.clockedIn && now ? Math.max(0, Math.floor((now - Date.parse(state.computedAt)) / 1000)) : 0;
  const total = state.workedSeconds + elapsed;

  const send = (expect: "in" | "out", geo?: Geo) => {
    setOptimistic(expect === "in");
    start(async () => {
      const r = await punchAction({ expect, ...(geo ? { lat: geo.lat, lng: geo.lng, accuracy: geo.accuracy } : {}), comment: comment.trim() || undefined });
      setOptimistic(null);
      setNow(null);
      if (r.ok) {
        setGeoProblem(null); setComment(""); setCommentError(null);
        const where = r.data?.fence ? ` at ${r.data.fence}` : "";
        toast.success(expect === "in" ? `Clocked in at ${time(r.data!.at)}${where}` : `Clocked out at ${time(r.data!.at)}${where}`);
        return;
      }
      if (r.field === "comment") { setCommentError(r.error); return; }
      if (r.field === "location" && !geo) { void withLocation(expect); return; }   // the server wants a location: ask once
      if (r.field === "location") { setGeoProblem({ kind: "outside", message: r.error }); return; }
      toast.error(r.error);
    });
  };

  const withLocation = async (expect: "in" | "out") => {
    setLocating(true); setGeoProblem(null);
    try {
      const geo = await locate();
      setLocating(false);
      send(expect, geo);
    } catch (e) {
      setLocating(false);
      const kind = (e as { kind?: GeoProblem["kind"] }).kind ?? "unavailable";
      setGeoProblem({ kind, message: kind === "outside" ? "" : GEO_COPY[kind] });
    }
  };

  const click = () => {
    if (cap.commentRequired && !comment.trim()) { setCommentError("Add a short comment to clock in or out."); return; }
    send(clockedIn ? "out" : "in");
  };
  const off = state.dayType === "weekly_off" || state.dayType === "holiday";
  const busy = pending || locating;
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm text-text-muted">
            {state.shift ? `${state.shift.name} shift · ${state.shift.start} – ${state.shift.end}` : off ? (state.dayType === "holiday" ? "Holiday today" : "Weekly off today") : "No shift today"}
          </p>
          <p className="mt-1 text-2xl font-semibold tabular" aria-live="off">{hms(total)}</p>
          <p className="text-sm text-text-muted">
            {state.clockedIn && state.since ? `Clocked in since ${time(state.since)}` : state.firstIn ? `First in at ${time(state.firstIn)}` : "You haven't clocked in today"}
          </p>
        </div>
        <Badge tone={clockedIn ? "success" : "neutral"}>{clockedIn ? "Working" : "Not working"}</Badge>
      </div>
      {cap.remoteToday && (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-text-muted"><House className="size-4" aria-hidden />{cap.remoteToday === "wfh" ? "Working from home today: clock in from anywhere." : "On duty today: clock in from anywhere."}</p>
      )}
      {cap.commentRequired && (
        <Field className="mt-3" label="Comment" required error={commentError ?? undefined}>
          <Input value={comment} onChange={(e) => { setComment(e.target.value); setCommentError(null); }} maxLength={500} placeholder="e.g. Client site in Whitefield" />
        </Field>
      )}
      {geoProblem && (
        <Banner className="mt-3" tone={geoProblem.kind === "outside" ? "warning" : "danger"} title={geoProblem.kind === "outside" ? "You're outside the clock-in area" : "We need your location"}>
          <span className="flex gap-2"><MapPinOff className="mt-0.5 size-4 shrink-0" aria-hidden />{geoProblem.message}</span>
        </Banner>
      )}
      <Button className="mt-4" size="lg" block variant={clockedIn ? "secondary" : "primary"} onClick={click} loading={busy}>
        {locating ? <><MapPin />Finding your location…</> : clockedIn ? <><LogOut />Clock out</> : <><LogIn />Clock in</>}
      </Button>
      {geoProblem && geoProblem.kind !== "unsupported" && (
        <Button className="mt-2" variant="ghost" size="sm" block onClick={() => withLocation(clockedIn ? "out" : "in")} disabled={busy}><MapPin />Try location again</Button>
      )}
      {!cap.webEnabled && !cap.locationCapture && !cap.remoteToday && (
        <p className="mt-3 text-sm text-text-muted">Browser clock-in is off for you. Use your office&apos;s attendance device.</p>
      )}
    </Card>
  );
}
