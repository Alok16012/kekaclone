import { describe, expect, it } from "vitest";
import { labourCodeCheck, unitPay, unitRates, csv, type PayItem } from "./rules";
import { annexure1Csv, annexure2Csv, quarterMonths, quarterOf } from "./tds24q";
import { journalLines, journalTotals, tallyJournalXml, zohoJournalCsv, ledgerName } from "./accounting";
import { cellToUnits, importKey, kindFromCell, rowProblems } from "./import-rules";

const R = (rupees: number) => rupees * 100;
const item = (code: string, paise: number, kind: PayItem["kind"] = "salary"): PayItem => ({ code, label: code, paise, kind });

describe("Labour Codes 50% wages rule", () => {
  it("passes when basic + DA is at least half of remuneration", () => {
    const r = labourCodeCheck([item("BASIC", R(50_000)), item("HRA", R(20_000)), item("SPECIAL", R(28_200))]);
    expect(r.ok).toBe(true); expect(r.wagesPaise).toBe(R(50_000)); expect(r.remunerationPaise).toBe(R(98_200)); expect(r.shortfallPaise).toBe(0); expect(r.pct).toBe(50.9);
  });
  it("flags a structure heavy on allowances and says how much more should be wages", () => {
    const r = labourCodeCheck([item("BASIC", R(30_000)), item("HRA", R(15_000)), item("SPECIAL", R(55_000))]);
    expect(r.ok).toBe(false); expect(r.requiredPaise).toBe(R(50_000)); expect(r.shortfallPaise).toBe(R(20_000)); expect(r.pct).toBe(30);
  });
  it("counts DA and retaining allowance as wages, arrears by their base code, and ignores reimbursements", () => {
    const r = labourCodeCheck([item("BASIC", R(40_000)), item("DA", R(5_000)), item("RETAINING_ALLOWANCE", R(5_000)), item("ARR_BASIC", R(2_000), "arrear"), item("SPECIAL", R(50_000)), item("FUEL", R(30_000), "reimbursement")]);
    expect(r.wagesPaise).toBe(R(52_000)); expect(r.remunerationPaise).toBe(R(102_000)); expect(r.ok).toBe(true);
  });
  it("is fine with nothing paid", () => { expect(labourCodeCheck([]).ok).toBe(true); expect(labourCodeCheck([]).pct).toBeNull(); });
});

describe("daily wages and piece rate", () => {
  it("pays rate × units, rounded to the rupee", () => {
    expect(unitPay(R(800), 22)).toBe(R(17_600));
    expect(unitPay(R(800), 22.5)).toBe(R(18_000));
    expect(unitPay(33_333, 3)).toBe(R(1_000));   // 333.33 × 3 = 999.99 → 1,000
    expect(unitPay(R(12), 0)).toBe(0);
  });
  it("takes the rates from the last salary segment of the month", () => {
    expect(unitRates([{ salaryId: "a", breakup: { BASIC: 1 }, from: "2026-04-01", to: "2026-04-10", employedDays: 10, payableDays: 10 }, { salaryId: "b", breakup: { BASIC: 2 }, from: "2026-04-11", to: "2026-04-30", employedDays: 20, payableDays: 20 }])).toEqual({ BASIC: 2 });
    expect(unitRates([])).toEqual({});
  });
});

describe("Form 24Q data", () => {
  it("knows the quarters of a financial year", () => {
    expect(quarterMonths("2026-04-01", 1)).toEqual(["2026-04-01", "2026-05-01", "2026-06-01"]);
    expect(quarterMonths("2026-04-01", 4)).toEqual(["2027-01-01", "2027-02-01", "2027-03-01"]);
    expect(quarterOf("2026-04-01")).toBe(1); expect(quarterOf("2026-12-01")).toBe(3); expect(quarterOf("2027-02-01")).toBe(4);
  });
  it("writes Annexure I rows in month and employee order, marking missing PANs", () => {
    const r = annexure1Csv([
      { employeeNumber: "E2", name: "B", pan: null, month: "2026-05-01", paidOn: "2026-05-31", amountPaise: R(50_000), tdsPaise: 0 },
      { employeeNumber: "E1", name: "A", pan: "ABCDE1234F", month: "2026-04-01", paidOn: "2026-04-30", amountPaise: R(80_000), tdsPaise: R(5_000) },
    ], { fy: "2026-27", q: 1 });
    const lines = r.text.trim().split("\r\n");
    expect(lines[0]).toMatch(/Annexure I data, FY 2026-27, Q1/);
    expect(lines[2]).toBe("1,E1,192A,ABCDE1234F,A,2026-04-30,80000.00,5000.00,0.00,0.00,5000.00,,2026-04-30,,");
    expect(lines[3]).toBe("2,E2,192A,PANNOTAVBL,B,2026-05-31,50000.00,0.00,0.00,0.00,0.00,,,C,No PAN on file");
    expect(r.name).toBe("24q-annexure1-fy2026-27-q1.csv"); expect(r.rows).toBe(2);
  });
  it("writes Annexure II with the shortfall column worked out", () => {
    const r = annexure2Csv([{ employeeNumber: "E1", name: "A", pan: "ABCDE1234F", regime: "new", from: "2026-04-01", to: "2027-03-31", grossSalaryPaise: R(12_00_000), exemptPaise: 0, standardDeductionPaise: R(75_000),
      professionalTaxPaise: R(2_400), otherIncomePaise: 0, chapterVIAPaise: 0, taxableIncomePaise: R(11_22_600), taxPaise: R(60_000), rebatePaise: 0, surchargePaise: 0, cessPaise: R(2_400), totalTaxPaise: R(62_400), tdsPaise: R(60_000), previousEmployerIncomePaise: 0, previousEmployerTdsPaise: R(1_000) }], { fy: "2026-27" });
    const lines = r.text.trim().split("\r\n");
    expect(lines[2].endsWith(",62400.00,1000.00,60000.00,1400.00")).toBe(true);
    expect(lines[2]).toContain("New (115BAC)");
  });
});

describe("accounting exports", () => {
  const lines = journalLines([
    { earnings: [item("BASIC", R(50_000)), item("HRA", R(20_000)), item("FUEL", R(3_000), "reimbursement")], deductions: [item("PF_EMPLOYEE", R(1_800), "statutory"), item("LOAN_EMI", R(5_000), "input")], employer: [{ code: "PF_EMPLOYER", label: "PF (employer share)", paise: R(1_800), kind: "employer" }], netPaise: R(66_200) },
    { earnings: [item("BASIC", R(30_000))], deductions: [item("PF_EMPLOYEE", R(1_800), "statutory")], employer: [], netPaise: R(28_200) },
  ], { BASIC: "5001", HRA: null, PF_EMPLOYER: "5101", LOAN_EMI: "1401" });
  it("balances and names ledgers by GL code", () => {
    const t = journalTotals(lines);
    expect(t.debitPaise).toBe(t.creditPaise);
    expect(t.debitPaise).toBe(R(50_000 + 20_000 + 3_000 + 1_800 + 30_000));
    expect(lines.find((l) => l.account === "5001 · Salary: BASIC")?.paise).toBe(R(80_000));
    expect(lines.find((l) => l.account === "Salary: HRA")).toBeTruthy();
    expect(lines.find((l) => l.account === "1401 · Recovered: LOAN_EMI")?.side).toBe("credit");
    expect(lines.find((l) => l.account === "Payable: PF")?.paise).toBe(R(1_800));
    expect(lines.find((l) => l.account === "Net salaries payable")?.paise).toBe(R(94_400));
    expect(ledgerName("Basic", null)).toBe("Basic");
  });
  it("writes a Tally journal voucher with debits deemed positive and negative amounts", () => {
    const x = tallyJournalXml(lines, { company: "Acme & Co", month: "2026-09-01", voucherDate: "2026-09-30" });
    expect(x.text).toContain("<SVCURRENTCOMPANY>Acme &amp; Co</SVCURRENTCOMPANY>");
    expect(x.text).toContain("<DATE>20260930</DATE>");
    expect(x.text).toContain("<LEDGERNAME>5001 · Salary: BASIC</LEDGERNAME>\n          <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>\n          <AMOUNT>-80000.00</AMOUNT>");
    expect(x.text).toContain("<LEDGERNAME>Net salaries payable</LEDGERNAME>\n          <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>\n          <AMOUNT>94400.00</AMOUNT>");
    expect(x.name).toBe("tally-payroll-2026-09.xml");
  });
  it("writes a Zoho Books journal CSV with one row per ledger line", () => {
    const z = zohoJournalCsv(lines, { month: "2026-09-01", voucherDate: "2026-09-30", reference: "PAY-2026-09" });
    const rows = z.text.trim().split("\r\n");
    expect(rows[0]).toBe("Journal Date,Reference Number,Notes,Currency,Account,Account Code,Debit,Credit,Description");
    expect(rows.length).toBe(lines.length + 1);
    expect(rows.some((r) => r.startsWith("2026-09-30,PAY-2026-09,Salary for Sep 26 (exported from erp),INR,5001 · Salary: BASIC,5001,80000.00,,"))).toBe(true);
  });
  it("csv escapes formulas", () => { expect(csv([["=1+1"]])).toBe("'=1+1\r\n"); });
});

describe("payroll input import rules", () => {
  it("reads kinds from labels or codes", () => {
    expect(kindFromCell("Bonus")).toBe("bonus"); expect(kindFromCell("adhoc_deduction")).toBe("adhoc_deduction"); expect(kindFromCell("one-time payment")).toBe("adhoc_earning"); expect(kindFromCell("holiday")).toBeNull();
  });
  it("reads units", () => { expect(cellToUnits("22.5")).toBe(22.5); expect(cellToUnits(0)).toBeNull(); expect(cellToUnits("1,000")).toBeNull(); expect(cellToUnits("abc")).toBeNull(); });
  it("checks rows by kind", () => {
    const base = { rowNumber: 2, employee: "E1", note: null, component: null };
    expect(rowProblems({ ...base, kind: "bonus", amountPaise: R(500), days: null }, { unitWorker: false })).toEqual([]);
    expect(rowProblems({ ...base, kind: "bonus", amountPaise: null, days: null }, { unitWorker: false })).toEqual(["Amount must be rupees above zero, like 5000."]);
    expect(rowProblems({ ...base, kind: "payable_units", amountPaise: null, days: 22 }, { unitWorker: false })[0]).toMatch(/only for daily-wage/);
    expect(rowProblems({ ...base, kind: "payable_units", amountPaise: null, days: 22 }, { unitWorker: true })).toEqual([]);
    expect(rowProblems({ ...base, kind: "leave_encashment", amountPaise: null, days: 3 }, { unitWorker: false })).toEqual([]);
    expect(rowProblems({ ...base, employee: "", kind: null, amountPaise: null, days: null }, { unitWorker: null }).length).toBe(2);
  });
  it("keys a row by its content so a re-upload is the same input", () => {
    const a = importKey({ payGroupId: "g", month: "2026-09-01", employeeId: "e", kind: "bonus", amountPaise: 100, days: null, note: " hi ", componentId: null });
    expect(a).toBe(importKey({ payGroupId: "g", month: "2026-09-01", employeeId: "e", kind: "bonus", amountPaise: 100, days: null, note: "hi", componentId: null }));
    expect(a).not.toBe(importKey({ payGroupId: "g", month: "2026-09-01", employeeId: "e", kind: "bonus", amountPaise: 101, days: null, note: "hi", componentId: null }));
    expect(a).toHaveLength(32);
  });
});
