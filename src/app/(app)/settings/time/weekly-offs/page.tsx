import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { todayIn } from "@/lib/dates";
import { canAssignSomeone, canManagePolicies, listWeeklyOffs } from "@/server/modules/attendance/policies";
import { WeeklyOffSettings } from "@/features/attendance/settings/weekly-offs-ui";
import { NoAccess } from "../no-access";

export const metadata: Metadata = { title: "Weekly offs" };

export default async function WeeklyOffsPage() {
  const d = await load(async (tx, actor) => canAssignSomeone(actor) ? { rows: await listWeeklyOffs(tx, todayIn()), canEdit: canManagePolicies(actor) } : null);
  return d ? <WeeklyOffSettings rows={d.rows} canEdit={d.canEdit} /> : <NoAccess />;
}
