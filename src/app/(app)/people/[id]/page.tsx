import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { load } from "@/server/page-data";
import { getProfile, lookups } from "@/server/modules/employees/profile";
import { todayIn } from "@/lib/dates";
import { ProfileView } from "@/features/profile/profile-view";
import { praiseFor } from "@/server/modules/engage/service";
import { PraiseReceivedCard } from "@/features/engage/home-widgets";

export const metadata: Metadata = { title: "Profile" };

export default async function PersonPage(props: PageProps<"/people/[id]">) {
  const { id } = await props.params;
  if (!z.uuid().safeParse(id).success) notFound();
  const d = await load(async (tx, actor) => {
    const p = await getProfile(tx, actor, id);
    if (!p) return null;
    const [[m], praise] = await Promise.all([tx<{ manager_id: string | null }[]>`select manager_id from employees where id = ${id}`, praiseFor(tx, actor, id)]);
    return { p, lookups: p.access === "admin" ? await lookups(tx) : null, managerId: m.manager_id, praise };
  });
  if (!d) notFound();
  return <ProfileView p={d.p} lookups={d.lookups} today={todayIn()} currentManagerId={d.managerId}
    aboutExtra={<PraiseReceivedCard items={d.praise} self={d.p.access === "self"} />} />;
}
