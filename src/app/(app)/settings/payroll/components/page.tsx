import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { listComponents } from "@/server/modules/payroll/setup";
import { hasAnyPayrollAdmin, isPayrollAdmin } from "@/server/modules/payroll/access";
import { ComponentsAdmin } from "@/features/payroll/components-ui";
import { PayrollNoAccess } from "@/features/payroll/no-access";
import { StatutoryBanner } from "@/features/payroll/statutory-banner";
import { bannerProps } from "@/features/payroll/page-data";

export const metadata: Metadata = { title: "Salary components" };

export default async function ComponentsPage() {
  const d = await load(async (tx, actor) => (isPayrollAdmin(actor) ? { denied: false as const, rows: await listComponents(tx), banner: await bannerProps(tx, actor) } : { denied: true as const, scoped: hasAnyPayrollAdmin(actor) }));
  if (d.denied) return <PayrollNoAccess scoped={d.scoped} />;
  return <div className="flex flex-col gap-4"><StatutoryBanner {...d.banner} /><ComponentsAdmin rows={d.rows} /></div>;
}
