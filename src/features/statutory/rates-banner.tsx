import Link from "next/link";
import { Banner } from "@/ui/feedback";

export type RatesBannerStatus = { verified: boolean; stale: boolean; latest: { verified_by_name: string; verified_on: string } | null };

const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * The warning every payroll screen shows until the company records a CA check of the statutory rates
 * (load the status with verificationStatus(tx)). Renders nothing once the current rates are verified.
 */
export function UnverifiedRatesBanner({ status, link = true }: { status: RatesBannerStatus; link?: boolean }) {
  if (status.verified) return null;
  const more = link ? <> <Link href="/settings/payroll/statutory" className="font-medium underline underline-offset-2">Review the rates</Link></> : null;
  return (
    <Banner tone="warning" title={status.stale ? "Statutory rates changed since your CA's check" : "Statutory rates not yet checked by a CA"}>
      {status.stale && status.latest
        ? <>{status.latest.verified_by_name} checked an earlier version on {fmt(status.latest.verified_on)}. The PF, ESI, PT, LWF, gratuity and tax figures have changed since, so ask them to check again before you run live payroll.</>
        : <>erp&apos;s PF, ESI, professional tax, LWF, gratuity and income-tax figures come from general knowledge of Indian law and haven&apos;t been verified. Have a chartered accountant check them before you run live payroll.</>}
      {more}
    </Banner>
  );
}
