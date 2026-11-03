import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { listMeetings } from "@/server/modules/performance/one-on-ones";
import { peopleOptions, directReportIds } from "@/server/modules/performance/access";
import { OneOnOnesView } from "@/features/performance/one-on-ones-view";

export const metadata: Metadata = { title: "1:1 meetings" };

export default async function OneOnOnesPage(props: PageProps<"/me/performance/one-on-ones">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => {
    const [meetings, people, reports] = await Promise.all([listMeetings(tx, actor), peopleOptions(tx), directReportIds(tx, actor.employeeId)]);
    // direct reports first in the picker: they're who people usually meet
    const rs = new Set(reports);
    return { meetings, people: people.filter((p) => p.id !== actor.employeeId).sort((a, b) => Number(rs.has(b.id)) - Number(rs.has(a.id))), now: new Date().toISOString() };
  });
  return <OneOnOnesView {...d} openId={typeof sp.open === "string" ? sp.open : null} openNew={sp.new === "1"} />;
}
