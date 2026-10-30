import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { recentRevisions } from "@/server/modules/payroll/revisions";
import { hasAnyPayrollAdmin } from "@/server/modules/payroll/access";
import { RevisionsAdmin } from "@/features/payroll/revisions-ui";
import { PayrollNoAccess } from "@/features/payroll/no-access";
import { StatutoryBanner } from "@/features/payroll/statutory-banner";
import { bannerProps } from "@/features/payroll/page-data";

export const metadata: Metadata = { title: "Salary revisions" };

/** Scoped payroll admins can use this screen too; everything on it covers only their people. */
export default async function RevisionsPage() {
  const d = await load(async (tx, actor) => {
    if (!hasAnyPayrollAdmin(actor)) return null;
    const [rows, banner] = await Promise.all([recentRevisions(tx, actor), bannerProps(tx, actor)]);
    return { recent: rows.map((r) => ({ ...r, ctc_paise: Number(r.ctc_paise), created_at: r.created_at.toISOString() })), banner };
  });
  if (!d) return <PayrollNoAccess />;
  return <div className="flex flex-col gap-4"><StatutoryBanner {...d.banner} /><RevisionsAdmin recent={d.recent} /></div>;
}
