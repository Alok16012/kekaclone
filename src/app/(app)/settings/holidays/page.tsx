import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { listHolidayLists } from "@/server/modules/leave/holidays";
import { isLeaveAdmin } from "@/server/modules/leave/access";
import { orgOptions } from "@/server/modules/employees/service";
import { todayIn } from "@/lib/dates";
import { HolidayLists } from "@/features/leave-admin/holidays-ui";
import { NoAccess } from "@/features/leave-admin/route-error";

export const metadata: Metadata = { title: "Holidays" };

export default async function HolidaysPage(props: PageProps<"/settings/holidays">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => {
    if (!isLeaveAdmin(actor)) return null;
    const [data, opts] = await Promise.all([listHolidayLists(tx), orgOptions(tx)]);
    return { ...data, people: opts.people };
  });
  if (!d) return <NoAccess what="holiday settings" />;
  const thisYear = Number(todayIn().slice(0, 4));
  const asked = Number(sp.year);
  const year = Number.isInteger(asked) && asked >= 2000 && asked <= 2100 ? asked : thisYear;
  const years = [...new Set([thisYear, thisYear + 1, year, ...d.lists.map((l) => l.year)])].sort();
  return <HolidayLists lists={d.lists} holidays={d.holidays} locations={d.locations} people={d.people} years={years} year={year} />;
}
