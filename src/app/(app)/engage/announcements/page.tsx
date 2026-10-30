import type { Metadata } from "next";
import { load } from "@/server/page-data";
import * as engage from "@/server/modules/engage/service";
import { orgOptions } from "@/server/modules/employees/service";
import { PageHeader } from "@/ui/app-shell";
import { AnnouncementsAdmin } from "@/features/engage/announcements-admin";
import { EngageNav, NoAccess } from "@/features/engage/engage-nav";

export const metadata: Metadata = { title: "Announcements" };

export default async function AnnouncementsPage() {
  const d = await load(async (tx, actor) => {
    if (!engage.announceScope(actor)) return null;
    const [rows, options, opts] = await Promise.all([engage.announcementsAdmin(tx, actor), engage.composerOptions(tx, actor), orgOptions(tx)]);
    return { rows, options, people: opts.people.filter((p) => p.id !== actor.employeeId) };
  });
  return (
    <>
      <PageHeader title="Announcements" description="Company news on the Home wall: pin what matters, schedule what's coming." />
      {d ? <><EngageNav active="announcements" /><AnnouncementsAdmin rows={d.rows} options={d.options} people={d.people} /></> : <NoAccess />}
    </>
  );
}
