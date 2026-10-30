import type { Metadata } from "next";
import Link from "next/link";
import { CalendarDays } from "lucide-react";
import { load } from "@/server/page-data";
import { teamLeaveMonth } from "@/server/modules/leave/team";
import { todayIn } from "@/lib/dates";
import { PageHeader } from "@/ui/app-shell";
import { Button } from "@/ui/button";
import { TeamLeaveCalendar } from "@/features/team-leave-calendar";

export const metadata: Metadata = { title: "Team leave calendar" };

export default async function TeamLeavePage(props: PageProps<"/team/leave">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => {
    const today = todayIn();
    const month = typeof sp.month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.month) ? sp.month : today.slice(0, 7);
    return { today, data: await teamLeaveMonth(tx, actor, { month, view: typeof sp.view === "string" ? sp.view : undefined }) };
  });
  return (
    <>
      <PageHeader title="Team leave calendar" description="Who's off, day by day. Plan around each other's time away."
        actions={<Button asChild variant="secondary"><Link href="/me/leave"><CalendarDays />My leave</Link></Button>} />
      <TeamLeaveCalendar data={d.data} today={d.today} />
    </>
  );
}
