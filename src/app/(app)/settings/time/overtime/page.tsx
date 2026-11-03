import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { todayIn } from "@/lib/dates";
import { canAssignSomeone, canManagePolicies, listShifts } from "@/server/modules/attendance/policies";
import { listAllowancePolicies, listOvertimePolicies, listPayCodes, overtimeMonth } from "@/server/modules/attendance/overtime";
import { OvertimeSettings } from "@/features/attendance/settings/overtime-ui";
import { NoAccess } from "../no-access";

export const metadata: Metadata = { title: "Overtime" };

export default async function OvertimePage(props: PageProps<"/settings/time/overtime">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => {
    if (!canAssignSomeone(actor)) return null;
    const today = todayIn();
    const month = typeof sp.month === "string" && /^\d{4}-\d{2}$/.test(sp.month) ? sp.month : today.slice(0, 7);
    const [policies, payCodes, allowances, shifts, monthRows] = await Promise.all([listOvertimePolicies(tx), listPayCodes(tx), listAllowancePolicies(tx), listShifts(tx, today), overtimeMonth(tx, month)]);
    return { policies, payCodes, allowances, shifts: shifts.map((s) => ({ id: s.id, name: s.name, code: s.code })), monthRows, month, canEdit: canManagePolicies(actor) };
  });
  if (!d) return <NoAccess />;
  return <OvertimeSettings policies={d.policies} payCodes={d.payCodes} allowances={d.allowances} shifts={d.shifts} canEdit={d.canEdit} month={d.month} monthRows={d.monthRows} tab={typeof sp.tab === "string" ? sp.tab : undefined} />;
}
