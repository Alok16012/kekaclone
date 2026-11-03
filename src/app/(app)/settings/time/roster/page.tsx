import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { todayIn } from "@/lib/dates";
import { canAssignSomeone } from "@/server/modules/attendance/policies";
import { rosterWeek } from "@/server/modules/attendance/roster";
import { RosterBoard } from "@/features/attendance/settings/roster-ui";
import { NoAccess } from "../no-access";

export const metadata: Metadata = { title: "Roster" };

export default async function RosterPage(props: PageProps<"/settings/time/roster">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => {
    if (!canAssignSomeone(actor)) return null;
    const date = typeof sp.week === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.week) ? sp.week : todayIn();
    return rosterWeek(tx, actor, date, typeof sp.q === "string" ? sp.q : "");
  });
  return d ? <RosterBoard key={`${d.weekStart}:${typeof sp.q === "string" ? sp.q : ""}`} initial={d} /> : <NoAccess />;
}
