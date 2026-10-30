import "server-only";
import type { Tx } from "@/server/db";
import type { TaxDeductions } from "@/server/modules/statutory/rules";

/**
 * Declared deductions and exemptions for monthly TDS (HRA, 80C, previous employer …), for the financial year that
 * starts on `fyStart`. erp has no tax-declaration module yet, so this returns null and TDS uses the standard deduction
 * only. When the declarations module lands, its getTaxInputs(tx, employeeId, fyStart) should be called from here.
 */
export async function taxInputsFor(tx: Tx, employeeId: string, fyStart: string): Promise<TaxDeductions | null> {
  void tx; void employeeId; void fyStart;
  return null;
}
