import "server-only";
import type { Tx } from "@/server/db";
import type { TaxDeductions } from "@/server/modules/statutory/rules";
import { getTaxInputs } from "@/server/modules/tax/service";
import type { TaxExtra } from "./rules";

export type RunTaxInputs = {
  /** the regime chosen in the year's declaration, else the person's statutory profile */
  regime: "old" | "new";
  /** null until the person submits a declaration for the year: TDS then uses the standard deduction only */
  deductions: TaxDeductions | null;
  extra: Omit<TaxExtra, "ytdEmployeePfPaise"> | null;
};

/**
 * Declared deductions and exemptions for monthly TDS (HRA, 80C, 80D, 24(b), previous employer, other income) for the
 * financial year that starts on `fyStart`, from the tax declarations module. Payroll adds the person's actual PF and PT.
 * `asOf` decides whether the proof cut-off has passed (unverified items then count as zero).
 */
export async function taxInputsFor(tx: Tx, employeeId: string, fyStart: string, asOf?: string): Promise<RunTaxInputs> {
  const t = await getTaxInputs(tx, employeeId, fyStart, asOf ? { asOf } : {});
  if (t.status !== "submitted") return { regime: t.regime, deductions: null, extra: null };
  return {
    regime: t.regime,
    deductions: { ...t.taxDeductions, professionalTaxPaise: 0 },
    extra: {
      previousIncomePaise: t.previousEmployer.incomePaise, previousTdsPaise: t.previousEmployer.tdsPaise,
      previousPfPaise: t.previousEmployer.pfPaise, previousPtPaise: t.previousEmployer.ptPaise, otherIncomePaise: t.otherIncomePaise,
    },
  };
}
