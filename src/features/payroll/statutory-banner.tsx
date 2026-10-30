import Link from "next/link";
import { Banner } from "@/ui/feedback";

const HREF = "/settings/payroll/statutory";

/** Shown on payroll screens until a CA's review of the current statutory rates is on record. */
export function StatutoryBanner({ verified, stale, verifiedOn, caName, canRecord }: { verified: boolean; stale?: boolean; verifiedOn?: string | null; caName?: string | null; canRecord: boolean }) {
  if (verified) {
    return <p className="text-sm text-text-muted">Statutory rates checked by {caName} on {verifiedOn}. <Link href={HREF} className="text-accent-text underline-offset-4 hover:underline">Details</Link></p>;
  }
  return (
    <Banner tone="warning" title={stale ? "Statutory rates changed since your CA's check" : "Statutory rates not yet checked by a CA"}>
      {stale && caName
        ? <>{caName} checked an earlier version on {verifiedOn}. The rates have changed since, so ask them to check again before you run live payroll.</>
        : <>PF, ESI, professional tax, LWF, TDS and gratuity figures in erp come from general knowledge of Indian law and haven&apos;t been verified. Don&apos;t run live payroll on them until a chartered accountant has reviewed them.</>}{" "}
      <Link href={HREF} className="font-medium underline underline-offset-4">{canRecord ? "Record a CA review" : "See the rates"}</Link>
    </Banner>
  );
}
