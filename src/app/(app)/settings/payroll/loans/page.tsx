import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { listCategories } from "@/server/modules/loans/service";
import { hasAnyPayrollAdmin, isPayrollAdmin } from "@/server/modules/payroll/access";
import { PayrollNoAccess } from "@/features/payroll/no-access";
import { LoanCategories } from "@/features/loans/categories";

export const metadata: Metadata = { title: "Loan types" };

export default async function LoanTypesPage() {
  const d = await load(async (tx, actor) => {
    if (!hasAnyPayrollAdmin(actor)) return null;
    return { rows: await listCategories(tx), canEdit: isPayrollAdmin(actor) };
  });
  if (!d) return <PayrollNoAccess />;
  return <LoanCategories rows={d.rows} canEdit={d.canEdit} />;
}
