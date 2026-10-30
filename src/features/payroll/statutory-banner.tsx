import Link from "next/link";
import { Banner } from "@/ui/feedback";

/** Shown on payroll screens until a CA's review of the statutory rates is on record. */
export function StatutoryBanner({ verified, verifiedOn, caName, canRecord }: { verified: boolean; verifiedOn?: string | null; caName?: string | null; canRecord: boolean }) {
  if (verified) {
    return <p className="text-sm text-text-muted">Statutory rates reviewed by {caName} on {verifiedOn}. <Link href="/settings/payroll/compliance" className="text-accent-text underline-offset-4 hover:underline">Details</Link></p>;
  }
  return (
    <Banner tone="warning" title="Statutory rates not yet checked by a CA">
      PF, ESI, professional tax, LWF, TDS and gratuity figures in erp come from general knowledge of Indian law and haven&apos;t been verified.
      Don&apos;t run live payroll on them until a chartered accountant has reviewed them.{" "}
      <Link href="/settings/payroll/compliance" className="font-medium underline underline-offset-4">{canRecord ? "Record a CA review" : "See the rates"}</Link>
    </Banner>
  );
}
