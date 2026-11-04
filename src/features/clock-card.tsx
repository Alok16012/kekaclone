"use client";
import * as React from "react";
import { Camera, House, Hourglass, LogIn, LogOut, MapPin, MapPinOff, Smartphone, X } from "lucide-react";
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

type Geo = { lat: number; lng: number; accuracy: number; fixAgeMs: number };
type GeoProblem = { kind: "denied" | "unavailable" | "timeout" | "unsupported" | "outside"; message: string };

/**
 * Asks the browser for a fresh position (only ever from a click). maximumAge 0 means no cached last-known position;
 * the fix's own timestamp is sent along so the server can refuse a stale one too.
 */
function locate(): Promise<Geo> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return reject({ kind: "unsupported" });
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, fixAgeMs: Math.max(0, Date.now() - p.timestamp) }),
      (e) => reject({ kind: e.code === e.PERMISSION_DENIED ? "denied" : e.code === e.TIMEOUT ? "timeout" : "unavailable" }),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  });
}

const GEO_COPY: Record<Exclude<GeoProblem["kind"], "outside">, string> = {
  denied: "Location is blocked for this site. Allow location in your browser's site settings (the icon next to the address bar), then try again.",
  unavailable: "We couldn't get your location. Turn on location services on your device and try again.",
  timeout: "Finding your location took too long. Move closer to a window or turn on Wi-Fi, then try again.",
  unsupported: "This browser can't share your location. Try a different browser, or clock in from the office network.",
};

const DEVICE_KEY = "erp.clockDevice";
const INSTALL_HINT_KEY = "erp.installHintDismissed";

/** A random id this browser keeps, so the server can tell "a device you've clocked in from before" from a new one. The server stores only a hash of it. */
function deviceKey(): string | null {
  try {
    let k = localStorage.getItem(DEVICE_KEY);
    if (!k || !/^[A-Za-z0-9_-]{16,64}$/.test(k)) {
      const bytes = new Uint8Array(24); crypto.getRandomValues(bytes);
      k = Array.from(bytes, (b) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[b % 64]).join("");
      localStorage.setItem(DEVICE_KEY, k);
    }
    return k;
  } catch { return null; }
}
function deviceLabel(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

type BeforeInstallPromptEvent = Event & { prompt: () => Promise<void> };

/** "Add to home screen" hint: shown once the browser says the app is installable (or on iOS Safari, where it must be done by hand). */
function useInstallHint() {
  const [prompt, setPrompt] = React.useState<BeforeInstallPromptEvent | null>(null);
  const [ios, setIos] = React.useState(false);
  const [show, setShow] = React.useState(false);
  React.useEffect(() => {
    let dismissed = false;
    try { dismissed = localStorage.getItem(INSTALL_HINT_KEY) === "1"; } catch { /* storage blocked: show the hint each time */ }
    const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
    if (dismissed || standalone) return;
    const onPrompt = (e: Event) => { e.preventDefault(); setPrompt(e as BeforeInstallPromptEvent); setShow(true); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    // iOS Safari never fires beforeinstallprompt; the hint there explains the manual steps (deferred: no state changes inside the effect body)
    const iosSafari = /iPhone|iPad/.test(navigator.userAgent) && /Safari\//.test(navigator.userAgent) && !/CriOS|FxiOS/.test(navigator.userAgent);
    const t = iosSafari ? setTimeout(() => { setIos(true); setShow(true); }, 0) : null;
    return () => { window.removeEventListener("beforeinstallprompt", onPrompt); if (t) clearTimeout(t); };
  }, []);
  const dismiss = () => { setShow(false); try { localStorage.setItem(INSTALL_HINT_KEY, "1"); } catch { /* fine */ } };
  const install = async () => { if (prompt) { await prompt.prompt(); } dismiss(); };
  return { show, ios, install, dismiss, canPrompt: !!prompt };
}

/** Camera preview → one JPEG frame (max 640 px wide, ~60 KB). The stream is stopped as soon as the photo is taken or the sheet closes. */
function SelfieSheet({ onCapture, onCancel }: { onCapture: (dataUrl: string) => void; onCancel: () => void }) {
  const video = React.useRef<HTMLVideoElement>(null);
  const stream = React.useRef<MediaStream | null>(null);
  // rendered only after a click, so reading the browser here never runs on the server
  const [error, setError] = React.useState<string | null>(() => (typeof navigator !== "undefined" && !navigator.mediaDevices?.getUserMedia ? "This browser can't use the camera. Try another browser, or clock in from the office network." : null));
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    let live = true;
    if (!navigator.mediaDevices?.getUserMedia) return;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 640 } }, audio: false })
      .then((s) => { if (!live) { s.getTracks().forEach((t) => t.stop()); return; } stream.current = s; if (video.current) { video.current.srcObject = s; video.current.play().catch(() => {}); } setReady(true); })
      .catch((e: DOMException) => setError(e.name === "NotAllowedError" ? "Camera access is blocked for this site. Allow the camera in your browser's site settings, then try again." : "We couldn't start the camera. Close other apps using it and try again."));
    return () => { live = false; stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; };
  }, []);
  const snap = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const scale = Math.min(1, 640 / v.videoWidth);
    const c = document.createElement("canvas");
    c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
    c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
    const dataUrl = c.toDataURL("image/jpeg", 0.7);
    stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null;
    onCapture(dataUrl);
  };
  return (
    <div role="dialog" aria-label="Take a selfie" className="mt-3 rounded-lg border border-border bg-surface-sunken p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-text-muted">Your clock-in rules ask for a selfie. It&apos;s stored with the clock-in for HR to see; it isn&apos;t matched against anything.</p>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Cancel selfie" onClick={onCancel}><X /></Button>
      </div>
      {error ? <Banner className="mt-2" tone="danger">{error}</Banner> : (
        <video ref={video} playsInline muted className="mt-2 aspect-square w-full max-w-xs rounded-md bg-surface object-cover [transform:scaleX(-1)]" aria-label="Camera preview" />
      )}
      <Button type="button" className="mt-3" block onClick={snap} disabled={!ready || !!error}><Camera />Take photo and clock in</Button>
    </div>
  );
}

/**
 * Clock in/out with a live timer. Worked time = server total at `computedAt` + seconds elapsed since then while clocked in.
 * The first render uses only server values (no clock reads), so server and client HTML match.
 * Location is asked for only when the server says this punch needs it (off the office network under a geofence policy);
 * a selfie and the manager's approval of a new device follow the same policy, and the server decides every time.
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
  const [selfieFor, setSelfieFor] = React.useState<{ expect: "in" | "out"; geo: Geo } | null>(null);
  const [selfieError, setSelfieError] = React.useState<string | null>(null);
  const [awaiting, setAwaiting] = React.useState<string | null>(state.pendingClockIn?.at ?? null);
  const install = useInstallHint();
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

  const send = (expect: "in" | "out", geo?: Geo, selfie?: string) => {
    if (typeof navigator !== "undefined" && navigator.onLine === false) { enqueue(expect, geo); return; }
    setOptimistic(expect === "in");
    start(async () => {
      let r: Awaited<ReturnType<typeof punchAction>>;
      try {
        r = await punchAction({
          expect, ...(geo ? { lat: geo.lat, lng: geo.lng, accuracy: geo.accuracy, fixAgeMs: geo.fixAgeMs } : {}), comment: comment.trim() || undefined,
          selfie: selfie ?? null, deviceKey: geo ? deviceKey() : null, deviceLabel: geo ? deviceLabel() : null,
        });
      }
      catch (e) { setOptimistic(null); setNow(null); if (isNetworkError(e)) { setOffline(true); enqueue(expect, geo); return; } toast.error(t("common.error")); return; }
      setOptimistic(null);
      setNow(null);
      if (r.ok) {
        setGeoProblem(null); setComment(""); setCommentError(null); setSelfieError(null);
        const where = r.data?.fence ? ` · ${r.data.fence}` : "";
        if (r.data?.pendingApproval) { setAwaiting(r.data.at); toast.success(`Clock-in sent for approval${where}`, { description: "It counts once your manager approves this device." }); return; }
        toast.success(`${t(expect === "in" ? "clock.in_done" : "clock.out_done", { time: time(r.data!.at) })}${where}`);
        return;
      }
      if (r.field === "comment") { setCommentError(r.error); return; }
      if (r.field === "selfie") { setSelfieError(r.error); if (geo) setSelfieFor({ expect, geo }); return; }
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
      if (cap.accuracyM != null && geo.accuracy > cap.accuracyM) {
        setGeoProblem({ kind: "outside", message: `Your location is only accurate to about ${Math.round(geo.accuracy)} m; this needs ${cap.accuracyM} m or better. Step outside or turn on GPS and try again.` });
        return;
      }
      if (cap.selfie) { setSelfieFor({ expect, geo }); return; }   // the photo is taken right after the fix, so both are fresh
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
        <Badge tone={awaiting ? "warning" : queuedIn ? "success" : "neutral"}>{awaiting ? "Awaiting approval" : queuedIn ? t("clock.working") : t("clock.not_working")}</Badge>
      </div>
      {awaiting && (
        <Banner className="mt-3" tone="warning" title="Your clock-in is waiting for your manager">
          <span className="flex gap-2"><Hourglass className="mt-0.5 size-4 shrink-0" aria-hidden />You clocked in at {time(awaiting)} from a device you hadn&apos;t used here before. It counts as soon as it&apos;s approved; you&apos;ll be told either way.</span>
        </Banner>
      )}
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
      {selfieError && !selfieFor && <Banner className="mt-3" tone="danger">{selfieError}</Banner>}
      {selfieFor ? (
        <SelfieSheet onCapture={(dataUrl) => { const s = selfieFor; setSelfieFor(null); setSelfieError(null); send(s.expect, s.geo, dataUrl); }} onCancel={() => setSelfieFor(null)} />
      ) : (
        <Button className="mt-4" size="lg" block variant={queuedIn ? "secondary" : "primary"} onClick={click} loading={busy} disabled={!!awaiting}>
          {locating ? <><MapPin />{t("clock.locating")}</> : queuedIn ? <><LogOut />{t("clock.out")}</> : <><LogIn />{t("clock.in")}</>}
        </Button>
      )}
      {geoProblem && geoProblem.kind !== "unsupported" && !selfieFor && (
        <Button className="mt-2" variant="ghost" size="sm" block onClick={() => withLocation(queuedIn ? "out" : "in")} disabled={busy}><MapPin />{t("clock.try_location")}</Button>
      )}
      {!cap.webEnabled && !cap.locationCapture && !cap.remoteToday && (
        <p className="mt-3 text-sm text-text-muted">{t("clock.web_off")}</p>
      )}
      {cap.locationCapture && !cap.remoteToday && (
        <p className="mt-3 text-xs text-text-muted">
          Off the office network, your phone&apos;s live location is checked against your workplace{cap.accuracyM ? ` (needs ${cap.accuracyM} m accuracy or better)` : ""}{cap.selfie ? ", and a selfie is taken" : ""}{cap.firstClockInApproval ? "; the first time from a new device your manager approves it" : ""}.
        </p>
      )}
      {install.show && cap.locationCapture && (
        <div className="mt-3 flex items-start gap-2 rounded-md bg-surface-sunken p-3 text-sm">
          <Smartphone className="mt-0.5 size-4 shrink-0 text-text-muted" aria-hidden />
          <span className="flex-1">{install.ios ? "Add erp to your home screen for quicker clock-ins: tap Share, then “Add to Home Screen”." : "Install erp on this phone for quicker clock-ins."}</span>
          {install.canPrompt && <Button size="sm" variant="secondary" onClick={install.install}>Install</Button>}
          <Button size="icon-sm" variant="ghost" aria-label="Dismiss install hint" onClick={install.dismiss}><X /></Button>
        </div>
      )}
    </Card>
  );
}
