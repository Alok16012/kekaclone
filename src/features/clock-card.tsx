"use client";
import * as React from "react";
import { House, LogIn, LogOut, MapPin, MapPinOff } from "lucide-react";
import { Card } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Field, Input } from "@/ui/field";
import { Banner } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { useRouter } from "next/navigation";
import { CloudOff, Send } from "lucide-react";
import type { TodayState } from "@/server/modules/attendance/service";
import { punchAction } from "@/app/(app)/me/attendance/actions";
import { syncQueuedPunchesAction } from "@/app/(app)/me/attendance/offline-actions";
import { useT } from "@/i18n/client";

const hms = (s: number) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, "0")).join(":");

/* Offline queue (plat2): punches made without a network are kept on the device and sent when it's back. */
type Queued = { client_id: string; expect: "in" | "out"; at: string; lat?: number | null; lng?: number | null; accuracy?: number | null; comment?: string | null };
const QUEUE_KEY = "erp-punch-queue";
const readQueue = (): Queued[] => { try { const v = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };
const writeQueue = (q: Queued[]) => { try { if (q.length) localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); else localStorage.removeItem(QUEUE_KEY); } catch { /* storage unavailable */ } };
const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "") : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
/** A server action that never reached the server rejects (TypeError: fetch failed / Load failed). */
const isNetworkError = (e: unknown) => e instanceof TypeError || /fetch|network|load failed|offline/i.test(String((e as Error)?.message ?? e));

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
  const { t, time } = useT();
  const router = useRouter();
  const [queue, setQueue] = React.useState<Queued[]>([]);
  const [offline, setOffline] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);
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

  // queued punches: load after mount (no storage reads during render), send when the network returns
  const flush = React.useCallback(async () => {
    const q = readQueue();
    if (!q.length || syncing) return;
    setSyncing(true);
    try {
      const r = await syncQueuedPunchesAction(q);
      if (!r.ok) { toast.error(r.error); return; }
      const done = new Set([...r.data!.accepted, ...r.data!.rejected.map((x) => x.client_id)]);
      const left = q.filter((x) => !done.has(x.client_id));
      writeQueue(left); setQueue(left);
      if (r.data!.rejected.length) toast.error(`${t("clock.sync_problem")}: ${r.data!.rejected.map((x) => x.reason).join("; ")}`);
      else toast.success(t("clock.synced"));
      router.refresh();
    } catch { /* still offline: try again on the next online event */ } finally { setSyncing(false); }
  }, [syncing, t, router]);
  React.useEffect(() => {
    // the device's queue is external state: read it once the component is on screen, never during render
    const boot = setTimeout(() => {
      setQueue(readQueue());
      setOffline(navigator.onLine === false);
      if (navigator.onLine && readQueue().length) void flush();
    }, 0);
    const on = () => { setOffline(false); void flush(); };
    const off = () => setOffline(true);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { clearTimeout(boot); window.removeEventListener("online", on); window.removeEventListener("offline", off); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const enqueue = (expect: "in" | "out", geo?: Geo) => {
    const item: Queued = { client_id: newId(), expect, at: new Date().toISOString(), lat: geo?.lat ?? null, lng: geo?.lng ?? null, accuracy: geo?.accuracy ?? null, comment: comment.trim() || null };
    const q = [...readQueue(), item];
    writeQueue(q); setQueue(q); setComment("");
    toast.success(t("clock.queued"));
  };

  const send = (expect: "in" | "out", geo?: Geo) => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) { enqueue(expect, geo); return; }
    setOptimistic(expect === "in");
    start(async () => {
      let r: Awaited<ReturnType<typeof punchAction>>;
      try { r = await punchAction({ expect, ...(geo ? { lat: geo.lat, lng: geo.lng, accuracy: geo.accuracy } : {}), comment: comment.trim() || undefined }); }
      catch (e) { setOptimistic(null); setNow(null); if (isNetworkError(e)) { setOffline(true); enqueue(expect, geo); return; } toast.error(t("common.error")); return; }
      setOptimistic(null);
      setNow(null);
      if (r.ok) {
        setGeoProblem(null); setComment(""); setCommentError(null);
        const where = r.data?.fence ? ` · ${r.data.fence}` : "";
        toast.success(`${t(expect === "in" ? "clock.in_done" : "clock.out_done", { time: time(r.data!.at) })}${where}`);
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
    if (cap.commentRequired && !comment.trim()) { setCommentError(t("clock.comment_required")); return; }
    send(queuedIn ? "out" : "in");
  };
  const off = state.dayType === "weekly_off" || state.dayType === "holiday";
  const busy = pending || locating;
  /** what the person last did, counting punches still waiting on this device */
  const queuedIn = queue.length ? queue[queue.length - 1].expect === "in" : clockedIn;
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm text-text-muted">
            {state.shift ? t("clock.shift", { name: state.shift.name, start: state.shift.start, end: state.shift.end }) : off ? (state.dayType === "holiday" ? t("clock.holiday") : t("clock.weekly_off")) : t("clock.no_shift")}
          </p>
          <p className="mt-1 text-2xl font-semibold tabular" aria-live="off">{hms(total)}</p>
          <p className="text-sm text-text-muted">
            {state.clockedIn && state.since ? t("clock.since", { time: time(state.since) }) : state.firstIn ? t("clock.first_in", { time: time(state.firstIn) }) : t("clock.not_yet")}
          </p>
        </div>
        <Badge tone={queuedIn ? "success" : "neutral"}>{queuedIn ? t("clock.working") : t("clock.not_working")}</Badge>
      </div>
      {cap.remoteToday && (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-text-muted"><House className="size-4" aria-hidden />{cap.remoteToday === "wfh" ? "Working from home today: clock in from anywhere." : "On duty today: clock in from anywhere."}</p>
      )}
      {cap.commentRequired && (
        <Field className="mt-3" label={t("clock.comment")} required error={commentError ?? undefined}>
          <Input value={comment} onChange={(e) => { setComment(e.target.value); setCommentError(null); }} maxLength={500} placeholder="e.g. Client site in Whitefield" />
        </Field>
      )}
      {geoProblem && (
        <Banner className="mt-3" tone={geoProblem.kind === "outside" ? "warning" : "danger"} title={geoProblem.kind === "outside" ? "You're outside the clock-in area" : "We need your location"}>
          <span className="flex gap-2"><MapPinOff className="mt-0.5 size-4 shrink-0" aria-hidden />{geoProblem.message}</span>
        </Banner>
      )}
      {(queue.length > 0 || offline) && (
        <Banner className="mt-3" tone="warning" title={offline ? t("clock.offline") : undefined}
          action={queue.length > 0 && !offline ? <Button size="sm" variant="secondary" loading={syncing} onClick={() => void flush()}><Send />{t("clock.send_now")}</Button> : undefined}>
          <span className="flex gap-2"><CloudOff className="mt-0.5 size-4 shrink-0" aria-hidden />{queue.length > 0 ? t("clock.queued_count", { count: queue.length }) : t("clock.queued")}</span>
        </Banner>
      )}
      <Button className="mt-4" size="lg" block variant={queuedIn ? "secondary" : "primary"} onClick={click} loading={busy}>
        {locating ? <><MapPin />{t("clock.locating")}</> : queuedIn ? <><LogOut />{t("clock.out")}</> : <><LogIn />{t("clock.in")}</>}
      </Button>
      {geoProblem && geoProblem.kind !== "unsupported" && (
        <Button className="mt-2" variant="ghost" size="sm" block onClick={() => withLocation(queuedIn ? "out" : "in")} disabled={busy}><MapPin />{t("clock.try_location")}</Button>
      )}
      {!cap.webEnabled && !cap.locationCapture && !cap.remoteToday && (
        <p className="mt-3 text-sm text-text-muted">{t("clock.web_off")}</p>
      )}
    </Card>
  );
}
