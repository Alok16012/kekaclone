"use client";
import * as React from "react";
import { Bell, Mail } from "lucide-react";
import { Card, CardHeader } from "@/ui/card";
import { Switch } from "@/ui/choice";
import { Banner } from "@/ui/feedback";
import { toast } from "@/ui/toast";
import { setNotificationChannelsAction } from "@/app/(app)/settings/notifications/actions";
import type { EventSetting } from "@/server/modules/notifications/service";

/** Per event: in-app on/off, email on/off. Changes save straight away. */
export function NotificationSettings({ groups, canEdit, emailConfigured }: { groups: { group: string; events: EventSetting[] }[]; canEdit: boolean; emailConfigured: boolean }) {
  const [state, setState] = React.useState(() => Object.fromEntries(groups.flatMap((g) => g.events.map((e) => [e.key, { in_app: e.in_app, email: e.email }]))));
  const [pending, start] = React.useTransition();
  const toggle = (e: EventSetting, channel: "in_app" | "email", on: boolean) => {
    const prev = state[e.key];
    const next = { ...prev, [channel]: on };
    setState((s) => ({ ...s, [e.key]: next }));
    start(async () => {
      const r = await setNotificationChannelsAction({ event: e.key, channels: [...(next.in_app ? ["in_app" as const] : []), ...(next.email ? ["email" as const] : [])] });
      if (!r.ok) { toast.error(r.error); setState((s) => ({ ...s, [e.key]: prev })); }
    });
  };
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Notifications</h2>
        <p className="text-base text-text-muted">Which events show in the bell and which are also emailed. Sign-in codes, invites and password emails always go out.</p>
      </div>
      {!emailConfigured && <Banner tone="warning" title="Email isn't connected">Emails are recorded but not delivered until an admin adds RESEND_API_KEY to .env.local. In development they show up at /dev/mail.</Banner>}
      {!canEdit && <p className="text-sm text-text-muted">Only people who can change notification settings can edit these.</p>}
      {groups.map((g) => (
        <Card key={g.group}>
          <CardHeader title={g.group} />
          <table className="w-full border-t border-border text-base">
            <caption className="sr-only">{g.group} notification events</caption>
            <thead><tr className="text-left text-sm text-text-muted"><th scope="col" className="px-5 py-2 font-medium">Event</th><th scope="col" className="w-24 px-3 py-2 font-medium"><span className="inline-flex items-center gap-1"><Bell className="size-3.5" aria-hidden />In-app</span></th><th scope="col" className="w-24 px-3 py-2 font-medium"><span className="inline-flex items-center gap-1"><Mail className="size-3.5" aria-hidden />Email</span></th></tr></thead>
            <tbody>
              {g.events.map((e) => (
                <tr key={e.key} className="border-t border-border">
                  <td className="px-5 py-2.5">{e.label}</td>
                  <td className="px-3 py-2.5">{e.emailOnly ? <span className="text-sm text-text-muted">—</span> : <Switch aria-label={`In-app: ${e.label}`} checked={state[e.key].in_app} disabled={!canEdit || pending} onCheckedChange={(c) => toggle(e, "in_app", c)} />}</td>
                  <td className="px-3 py-2.5"><Switch aria-label={`Email: ${e.label}`} checked={state[e.key].email} disabled={!canEdit || pending} onCheckedChange={(c) => toggle(e, "email", c)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
    </div>
  );
}
