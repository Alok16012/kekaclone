import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { myCalendars } from "@/server/modules/calendar/service";
import { pushDevices, pushStatus } from "@/server/modules/push/service";
import { getLocale } from "@/i18n/server";
import { PageHeader } from "@/ui/app-shell";
import { ConnectionsPage } from "@/features/plat2/connections-ui";

export const metadata: Metadata = { title: "Calendar & devices" };

export default async function Connections(props: PageProps<"/me/connections">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => ({ calendars: await myCalendars(tx, actor), devices: await pushDevices(tx, actor), push: pushStatus(), locale: await getLocale() }));
  return (
    <>
      <PageHeader title="Calendar & devices" description="Your own connections: calendar sync, push notifications on this device, and the language erp speaks to you in." />
      <ConnectionsPage calendars={d.calendars} devices={d.devices} push={{ configured: d.push.configured, publicKey: d.push.publicKey, hint: d.push.hint }} locale={d.locale}
        notice={typeof sp.calendar_connected === "string" ? { tone: "success", text: "Calendar connected. Upcoming interviews, 1:1s and approved leave will appear there." } : typeof sp.calendar_error === "string" ? { tone: "danger", text: sp.calendar_error } : null} />
    </>
  );
}
