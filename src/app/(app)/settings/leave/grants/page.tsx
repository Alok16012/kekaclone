import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { listGrants } from "@/server/modules/leave/grants";
import { hasAnyLeaveAdmin } from "@/server/modules/leave/access";
import { orgOptions } from "@/server/modules/employees/service";
import { todayIn } from "@/lib/dates";
import { GrantsSettings } from "@/features/leave-admin/grants-ui";
import { NoAccess } from "@/features/leave-admin/route-error";

export const metadata: Metadata = { title: "Event-based leave" };

/** Per-event grants (marriage, bereavement …) for the people the admin manages. */
export default async function GrantsPage() {
  const d = await load(async (tx, actor) => {
    if (!hasAnyLeaveAdmin(actor)) return null;
    const [rows, opts, types] = await Promise.all([
      listGrants(tx, actor), orgOptions(tx),
      tx<{ id: string; name: string }[]>`select distinct t.id, t.name from leave_types t join leave_plan_rules r on r.leave_type_id = t.id where t.kind = 'incident' order by t.name`,
    ]);
    return { rows, people: opts.people.filter((p) => p.id !== actor.employeeId), types, today: todayIn() };
  });
  if (!d) return <NoAccess what="event-based leave" />;
  return <GrantsSettings rows={d.rows} people={d.people} types={d.types} today={d.today} />;
}
