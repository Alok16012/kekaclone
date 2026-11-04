/**
 * Form 24Q data export (pure, no I/O): the quarterly TDS-on-salary return laid out as Annexure I (deductee-wise tax
 * deducted in the quarter) and Annexure II (the year's salary details, filed with the fourth quarter). These are CSV
 * data files in a TRACES-style column layout for your return preparer, NOT the FVU/.txt file the portal takes:
 * challan details, the deductor's TAN and the filing itself happen outside erp. Rupees, as the return expects.
 */
import { csv, rupees, type ISODate } from "./rules";

export const QUARTERS = [
  { q: 1, label: "Q1 (April to June)", months: ["04", "05", "06"] },
  { q: 2, label: "Q2 (July to September)", months: ["07", "08", "09"] },
  { q: 3, label: "Q3 (October to December)", months: ["10", "11", "12"] },
  { q: 4, label: "Q4 (January to March)", months: ["01", "02", "03"] },
] as const;
export type Quarter = 1 | 2 | 3 | 4;

/** First-of-month dates of a quarter in the financial year starting `fyStart` (YYYY-04-01). */
export function quarterMonths(fyStart: ISODate, q: Quarter): ISODate[] {
  const y = Number(fyStart.slice(0, 4));
  return QUARTERS[q - 1].months.map((m) => `${q === 4 ? y + 1 : y}-${m}-01`);
}
export const quarterOf = (month: ISODate): Quarter => (([4, 5, 6].includes(Number(month.slice(5, 7))) ? 1 : [7, 8, 9].includes(Number(month.slice(5, 7))) ? 2 : [10, 11, 12].includes(Number(month.slice(5, 7))) ? 3 : 4) as Quarter);

export type Annex1Row = {
  employeeNumber: string; name: string; pan: string | null; month: ISODate; paidOn: ISODate | null;
  /** taxable salary paid in the month and the TDS taken from it */
  amountPaise: number; tdsPaise: number;
};

/** Annexure I: one row per person and month of the quarter where salary was paid (TDS may be zero). */
export function annexure1Csv(rows: Annex1Row[], a: { fy: string; q: Quarter }) {
  const sorted = [...rows].sort((x, y) => x.month.localeCompare(y.month) || x.employeeNumber.localeCompare(y.employeeNumber));
  const header = ["Sr no", "Employee serial no", "Section code", "PAN of deductee", "Name of deductee", "Date of payment or credit", "Amount paid or credited (Rs)",
    "TDS (Rs)", "Surcharge (Rs)", "Health and education cess (Rs)", "Total tax deducted (Rs)", "Total tax deposited (Rs)", "Date of deduction", "Reason for non-deduction or lower deduction", "Remarks"];
  const body = sorted.map((r, i) => [i + 1, r.employeeNumber, "192A", r.pan ?? "PANNOTAVBL", r.name, r.paidOn ?? r.month, rupees(r.amountPaise), rupees(r.tdsPaise), "0.00", "0.00",
    rupees(r.tdsPaise), "", r.tdsPaise ? r.paidOn ?? r.month : "", r.tdsPaise ? "" : (r.pan ? "" : "C"), r.pan ? "" : "No PAN on file"]);
  return {
    text: csv([[`Form 24Q Annexure I data, FY ${a.fy}, ${QUARTERS[a.q - 1].label}. Data export from erp: challan details, TAN and the FVU file are prepared outside erp.`], header, ...body]),
    name: `24q-annexure1-fy${a.fy}-q${a.q}.csv`, rows: body.length,
  };
}

export type Annex2Row = {
  employeeNumber: string; name: string; pan: string | null; regime: "old" | "new"; from: ISODate; to: ISODate;
  grossSalaryPaise: number; exemptPaise: number; standardDeductionPaise: number; professionalTaxPaise: number; otherIncomePaise: number;
  chapterVIAPaise: number; taxableIncomePaise: number; taxPaise: number; rebatePaise: number; surchargePaise: number; cessPaise: number; totalTaxPaise: number; tdsPaise: number;
  previousEmployerIncomePaise: number; previousEmployerTdsPaise: number;
};

/** Annexure II: the year's salary and tax per person (filed with Q4). */
export function annexure2Csv(rows: Annex2Row[], a: { fy: string }) {
  const sorted = [...rows].sort((x, y) => x.employeeNumber.localeCompare(y.employeeNumber));
  const header = ["Sr no", "Employee serial no", "PAN of employee", "Name of employee", "Tax regime", "Period from", "Period to", "Gross salary (Rs)", "Exemptions under section 10 (Rs)",
    "Standard deduction (Rs)", "Professional tax (Rs)", "Income from previous employer (Rs)", "Other income reported (Rs)", "Deductions under chapter VI-A (Rs)", "Total taxable income (Rs)",
    "Income tax on total income (Rs)", "Rebate under 87A (Rs)", "Surcharge (Rs)", "Health and education cess (Rs)", "Net tax payable (Rs)", "Tax deducted by previous employer (Rs)",
    "Total tax deducted by current employer (Rs)", "Shortfall or excess (Rs)"];
  const body = sorted.map((r, i) => [i + 1, r.employeeNumber, r.pan ?? "PANNOTAVBL", r.name, r.regime === "new" ? "New (115BAC)" : "Old", r.from, r.to,
    rupees(r.grossSalaryPaise), rupees(r.exemptPaise), rupees(r.standardDeductionPaise), rupees(r.professionalTaxPaise), rupees(r.previousEmployerIncomePaise), rupees(r.otherIncomePaise),
    rupees(r.chapterVIAPaise), rupees(r.taxableIncomePaise), rupees(r.taxPaise), rupees(r.rebatePaise), rupees(r.surchargePaise), rupees(r.cessPaise), rupees(r.totalTaxPaise),
    rupees(r.previousEmployerTdsPaise), rupees(r.tdsPaise), rupees(r.totalTaxPaise - r.tdsPaise - r.previousEmployerTdsPaise)]);
  return {
    text: csv([[`Form 24Q Annexure II data, FY ${a.fy} (filed with Q4). Data export from erp on statutory rates a CA has not verified; check before filing.`], header, ...body]),
    name: `24q-annexure2-fy${a.fy}.csv`, rows: body.length,
  };
}
