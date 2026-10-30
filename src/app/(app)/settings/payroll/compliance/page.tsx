import { permanentRedirect } from "next/navigation";

/** The CA sign-off moved to Settings → Payroll → Statutory rates; keep old links working. */
export default function CompliancePage() {
  permanentRedirect("/settings/payroll/statutory");
}
