import type { Metadata } from "next";
import { load } from "@/server/page-data";
import { caStatus, listStatutoryRates } from "@/server/modules/payroll/setup";
import { hasAnyPayrollAdmin, isPayrollAdmin } from "@/server/modules/payroll/access";
import { todayIn } from "@/lib/dates";
import { ComplianceAdmin } from "@/features/payroll/compliance-ui";
import { PayrollNoAccess } from "@/features/payroll/no-access";

export const metadata: Metadata = { title: "Statutory compliance" };

export default async function CompliancePage() {
  const d = await load(async (tx, actor) => {
    if (!hasAnyPayrollAdmin(actor)) return null;
    const [rates, s] = await Promise.all([listStatutoryRates(tx), caStatus(tx)]);
    return { rates, verification: s.verification ? { ...s.verification, at: s.verification.at.toISOString() } : null, current: s.current, canRecord: isPayrollAdmin(actor) };
  });
  if (!d) return <PayrollNoAccess />;
  return <ComplianceAdmin {...d} today={todayIn()} />;
}
