import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { z } from "zod";
import { load } from "@/server/page-data";
import { getProfile, lookups } from "@/server/modules/employees/profile";
import { todayIn } from "@/lib/dates";
import { ProfileView } from "@/features/profile/profile-view";

export const metadata: Metadata = { title: "Profile" };

export default async function PersonPage(props: PageProps<"/people/[id]">) {
  const { id } = await props.params;
  if (!z.uuid().safeParse(id).success) notFound();
  const d = await load(async (tx, actor) => {
    const p = await getProfile(tx, actor, id);
    if (!p) return null;
    const [m] = await tx<{ manager_id: string | null }[]>`select manager_id from employees where id = ${id}`;
    return { p, lookups: p.access === "admin" ? await lookups(tx) : null, managerId: m.manager_id };
  });
  if (!d) notFound();
  return <ProfileView p={d.p} lookups={d.lookups} today={todayIn()} currentManagerId={d.managerId} />;
}
