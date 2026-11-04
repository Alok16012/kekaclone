"use client";
import * as React from "react";
import { BellRing, CalendarDays, Languages, Smartphone, Unplug } from "lucide-react";
import { Button } from "@/ui/button";
import { Card, CardBody, CardHeader } from "@/ui/card";
import { Badge } from "@/ui/badge";
import { Banner } from "@/ui/feedback";
import { Field } from "@/ui/field";
import { Select } from "@/ui/select";
import { ConfirmDialog } from "@/ui/overlay";
import { toast } from "@/ui/toast";
import type { myCalendars, CalendarProvider } from "@/server/modules/calendar/service";
import type { pushDevices } from "@/server/modules/push/service";
import { LOCALE_LABELS, LOCALES, type Locale } from "@/i18n";
import { refreshLocale, useT } from "@/i18n/client";
import { disconnectCalendarAction, setLocaleAction, subscribePushAction, unsubscribePushAction } from "@/app/(app)/me/connections/actions";

type Calendars = Awaited<ReturnType<typeof myCalendars>>;
type Devices = Awaited<ReturnType<typeof pushDevices>>;

export function ConnectionsPage({ calendars, devices, push, locale, notice }: { calendars: Calendars; devices: Devices; push: { configured: boolean; publicKey: string | null; hint: string }; locale: Locale; notice: { tone: "success" | "danger"; text: string } | null }) {
  return (
    <div className="flex flex-col gap-4">
      {notice && <Banner tone={notice.tone}>{notice.text}</Banner>}
      <LanguageCard locale={locale} />
      <CalendarCard c={calendars} />
      <PushCard devices={devices} push={push} />
    </div>
  );
}

function LanguageCard({ locale }: { locale: Locale }) {
  const { t } = useT();
  const [pending, start] = React.useTransition();
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><Languages className="size-4 text-text-muted" aria-hidden />{t("lang.label")}</span>} description={t("lang.help")} />
      <CardBody>
        <Field label={t("lang.label")} className="max-w-xs">
          <Select value={locale} disabled={pending} onValueChange={(v) => start(async () => { const r = await setLocaleAction(v); if (r.ok) { refreshLocale(); toast.success(t("lang.saved")); window.location.reload(); } else toast.error(r.error); })}
            options={LOCALES.map((l) => ({ value: l, label: LOCALE_LABELS[l] }))} />
        </Field>
        <p className="mt-2 text-sm text-text-muted">Hindi covers the app shell, Home, Leave, Attendance, Inbox, Profile and sign-in. Other pages stay in English for now.</p>
      </CardBody>
    </Card>
  );
}

function CalendarCard({ c }: { c: Calendars }) {
  const [pending, start] = React.useTransition();
  const row = (provider: CalendarProvider, label: string, p: Calendars["google"]) => {
    const conn = c.connections.find((x) => x.provider === provider);
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3">
        <div className="min-w-0">
          <p className="text-base font-medium">{label}</p>
          <p className="text-sm text-text-muted">
            {conn ? <>Connected{conn.account_email ? ` as ${conn.account_email}` : ""}{conn.status === "error" ? ` · last sync failed: ${conn.last_error ?? "unknown error"}` : ""}</>
              : !p.configured ? "Not set up on this server yet." : !p.enabled ? "An admin hasn't turned this on under Settings → Integrations." : "Not connected."}
          </p>
        </div>
        {conn ? (
          <span className="flex items-center gap-2">
            <Badge tone={conn.status === "error" ? "danger" : "success"}>{conn.status === "error" ? "Needs attention" : "Connected"}</Badge>
            <ConfirmDialog trigger={<Button size="sm" variant="ghost" disabled={pending}><Unplug />Disconnect</Button>} title={`Disconnect ${label}?`} description="New events stop going to this calendar. Events already there stay." confirmLabel="Disconnect"
              onConfirm={() => start(async () => { const r = await disconnectCalendarAction(provider); if (r.ok) toast.success(`${label} disconnected`); else toast.error(r.error); })} />
          </span>
        ) : (
          <Button asChild size="sm" variant="secondary" disabled={!p.configured || !p.enabled}><a href={p.configured && p.enabled ? `/auth/calendar/${provider}/start` : undefined} aria-disabled={!p.configured || !p.enabled}>Connect</a></Button>
        )}
      </div>
    );
  };
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><CalendarDays className="size-4 text-text-muted" aria-hidden />Calendar sync</span>}
        description="Interviews you're on, your 1:1s and your approved leave appear in the calendar you connect. You can always download an .ics file instead." />
      <CardBody className="flex flex-col gap-3">
        {row("google", "Google Calendar", c.google)}
        {row("microsoft", "Outlook / Microsoft 365", c.microsoft)}
        {c.pending > 0 && <p className="text-sm text-text-muted">{c.pending} {c.pending === 1 ? "event is" : "events are"} waiting to sync; they go out within a minute of the next change or the nightly run.</p>}
      </CardBody>
    </Card>
  );
}

const urlB64ToBytes = (s: string) => { const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };

function PushCard({ devices, push }: { devices: Devices; push: { configured: boolean; publicKey: string | null; hint: string } }) {
  const [state, setState] = React.useState<"unknown" | "unsupported" | "denied" | "on" | "off">("unknown");
  const [endpoint, setEndpoint] = React.useState<string | null>(null);
  const [pending, start] = React.useTransition();
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      await Promise.resolve();   // browser capability checks happen after mount, off the render path
      if (cancelled) return;
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) { setState("unsupported"); return; }
      if (Notification.permission === "denied") { setState("denied"); return; }
      try { const s = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription(); if (!cancelled) { setEndpoint(s?.endpoint ?? null); setState(s ? "on" : "off"); } }
      catch { if (!cancelled) setState("off"); }
    })();
    return () => { cancelled = true; };
  }, []);
  const enable = () => start(async () => {
    try {
      if (process.env.NODE_ENV !== "production") localStorage.setItem("erp-pwa", "1");
      const reg = (await navigator.serviceWorker.getRegistration()) ?? (await navigator.serviceWorker.register("/sw.js", { scope: "/" }));
      await navigator.serviceWorker.ready;
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { setState(perm === "denied" ? "denied" : "off"); return; }
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(push.publicKey!) });
      const j = s.toJSON();
      const r = await subscribePushAction({ endpoint: s.endpoint, keys: { p256dh: j.keys?.p256dh ?? "", auth: j.keys?.auth ?? "" } });
      if (r.ok) { setEndpoint(s.endpoint); setState("on"); toast.success("Notifications on for this device"); } else toast.error(r.error);
    } catch (e) { toast.error(`Couldn't turn on notifications: ${(e as Error).message}`); }
  });
  const disable = () => start(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    const s = await reg?.pushManager.getSubscription();
    if (s) { await unsubscribePushAction(s.endpoint); await s.unsubscribe(); }
    setEndpoint(null); setState("off"); toast.success("Notifications off for this device");
  });
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><BellRing className="size-4 text-text-muted" aria-hidden />Push notifications</span>}
        description="Get approvals, replies and announcements on this phone or computer even when erp isn't open. Install erp to your home screen first on iPhone." />
      <CardBody className="flex flex-col gap-3">
        {!push.configured ? <Banner tone="warning" title="Not set up on this server">Add {push.hint}.</Banner>
          : state === "unsupported" ? <Banner tone="info">This browser can&apos;t receive push notifications. On iPhone, add erp to the home screen and open it from there.</Banner>
          : state === "denied" ? <Banner tone="warning">Notifications are blocked for this site. Allow them in your browser&apos;s site settings, then try again.</Banner>
          : (
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone={state === "on" ? "success" : "neutral"}>{state === "on" ? "On for this device" : state === "off" ? "Off on this device" : "Checking…"}</Badge>
              {state === "on" ? <Button size="sm" variant="secondary" loading={pending} onClick={disable}>Turn off here</Button> : state === "off" ? <Button size="sm" loading={pending} onClick={enable}><BellRing />Turn on for this device</Button> : null}
            </div>
          )}
        {devices.length > 0 && (
          <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
            {devices.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="flex items-center gap-2"><Smartphone className="size-4 text-text-muted" aria-hidden />{d.device}{d.endpoint === endpoint ? <Badge tone="accent" size="sm">This device</Badge> : null}</span>
                <Button size="sm" variant="ghost" loading={pending} onClick={() => start(async () => { const r = await unsubscribePushAction(d.endpoint); if (r.ok) toast.success("Device removed"); else toast.error(r.error); })}>Remove</Button>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
