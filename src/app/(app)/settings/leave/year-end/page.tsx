import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { listPlans } from "@/server/modules/leave/admin";
import { yearEndPreview } from "@/server/modules/leave/accrual";
import { isLeaveAdmin } from "@/server/modules/leave/access";
import { YearEnd } from "@/features/leave-admin/year-end-ui";
import { NoAccess } from "@/features/leave-admin/route-error";

export const metadata: Metadata = { title: "Year-end processing" };

export default async function YearEndPage(props: PageProps<"/settings/leave/year-end">) {
  const sp = await props.searchParams;
  const d = await load(async (tx, actor) => {
    if (!isLeaveAdmin(actor)) return null;
    const plans = await listPlans(tx);
    const plan = plans.find((p) => p.id === sp.plan) ?? plans[0];
    if (!plan) return { plans, plan: null, rows: [], totals: { carry: 0, encash: 0, lapse: 0, people: 0 }, months: [] };
    const p = await yearEndPreview(tx, actor, plan.id);
    return { plans, plan: p.plan, rows: p.rows, totals: p.totals, months: p.encashMonths };
  });
  if (!d) return <NoAccess />;
  return <YearEnd key={d.plan?.id ?? "none"} plans={d.plans} plan={d.plan} rows={d.rows} totals={d.totals} months={d.months} />;
}
