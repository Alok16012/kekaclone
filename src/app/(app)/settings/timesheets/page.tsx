import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { policy } from "@/server/modules/psa/service";
import { canAdminPsa } from "@/server/modules/psa/access";
import { TimesheetPolicySettings } from "@/features/psa/policy-settings";

export const metadata: Metadata = { title: "Timesheet policy" };

export default async function TimesheetPolicyPage() {
  const d = await load(async (tx, actor) => ({ policy: await policy(tx), canEdit: canAdminPsa(actor) }));
  return <TimesheetPolicySettings policy={d.policy} canEdit={d.canEdit} />;
}
