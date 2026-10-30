import type { Calc, ComponentKind } from "@/server/modules/payroll/rules";

export const KIND_LABEL: Record<ComponentKind, string> = {
  earning: "Earning", reimbursable: "Reimbursable", deduction: "Deduction", reimbursement: "Reimbursement",
  adhoc_earning: "One-off earning", adhoc_deduction: "One-off deduction", bonus: "Bonus", employer_contribution: "Employer contribution",
};
export const KIND_HINT: Record<ComponentKind, string> = {
  earning: "Regular pay, part of CTC (Basic, HRA, allowances).",
  reimbursable: "Part of CTC, paid against bills (fuel, phone).",
  deduction: "Taken from pay each month (PF, PT, TDS). Not part of CTC.",
  reimbursement: "Paid back for expenses, outside CTC.",
  adhoc_earning: "Added in a payroll run when needed.",
  adhoc_deduction: "Deducted in a payroll run when needed.",
  bonus: "Bonus or one-time payment.",
  employer_contribution: "Paid by the company on top of gross, inside CTC (PF employer share).",
};
export const CALC_LABEL: Record<Calc, string> = {
  flat: "Fixed amount", pct_ctc: "% of CTC", pct_gross: "% of gross", formula: "Formula", balancing: "Balancing (rest of CTC)",
};
export const FREQ_LABEL: Record<string, string> = { monthly: "Monthly", quarterly: "Quarterly", half_yearly: "Half-yearly", yearly: "Yearly", one_time: "One time" };
export const BASIS_LABEL: Record<string, string> = { calendar: "Calendar days in the month", fixed_30: "Always 30 days", working: "Working days in the month" };
export const REASON_LABEL: Record<string, string> = { joining: "Joining", revision: "Revision", promotion: "Promotion", correction: "Correction" };

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 0, maximumFractionDigits: 2 });
/** ₹ with Indian grouping; paise shown only when there are any. */
export const money = (paise: number) => inr.format(paise / 100);
export const fmtDate = (d: string | null | undefined) => (d ? new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");
export const fmtMonth = (d: string | null | undefined) => (d ? new Date(d + "T00:00:00Z").toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" }) : "—");

/** Rupee text typed by a person ("12,00,000", "1200000.5") → paise, exact. Null when not an amount. */
export function rupeesToPaise(s: string): number | null {
  const m = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(s.replace(/[,\s₹]/g, ""));
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}
