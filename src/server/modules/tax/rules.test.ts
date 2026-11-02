import { describe, expect, it } from "vitest";
import { annualTax, compareRegimes } from "@/server/modules/statutory/rules";
import { RATE_ROWS } from "@/server/modules/statutory/rates-data";
import type { IncomeTaxConfig } from "@/server/modules/statutory/config";
import {
  annualRent, capped80D, checkRentPeriods, checkTaxSettings, countedPaise, daysEmployed, declarationWindow, DEFAULT_TAX_SETTINGS, fyLabel, fyMonths,
  fyStartFromLabel, fyStartOf, hraExemption, isKnownItem, isPan, limitsFor, mdInFy, panFromFileName, parseRupees, parseTaxSettings, projectSalary,
  proofsFinal, proofWindow, rentByMonth, sectionTotals, toTaxDeductions, type ItemRow, type RentPeriod,
} from "./rules";
import { readZip, writeZip, ZipError } from "./zip";

const L = limitsFor("2026-27");
const FY = "2026-04-01";
const taxConfig = (regime: "old" | "new") => RATE_ROWS.find((r) => r.kind === "income_tax" && r.regime === regime && (r.config as IncomeTaxConfig).fy === "2026-27")!.config as IncomeTaxConfig;

describe("financial years", () => {
  it("maps dates to their FY and back", () => {
    expect(fyStartOf("2026-10-30")).toBe("2026-04-01");
    expect(fyStartOf("2027-03-31")).toBe("2026-04-01");
    expect(fyStartOf("2027-04-01")).toBe("2027-04-01");
    expect(fyLabel("2026-04-01")).toBe("2026-27");
    expect(fyStartFromLabel("2026-27")).toBe("2026-04-01");
    expect(fyStartFromLabel("2026-28")).toBeNull();
    expect(fyStartFromLabel("2099-00")).toBe("2099-04-01");
    expect(fyMonths(FY)[0]).toBe("2026-04-01");
    expect(fyMonths(FY)[11]).toBe("2027-03-01");
    expect(mdInFy(FY, "01-15")).toBe("2027-01-15");
    expect(mdInFy(FY, "06-30")).toBe("2026-06-30");
    expect(mdInFy("2027-04-01", "02-29")).toBe("2028-02-29");
    expect(mdInFy(FY, "02-29")).toBe("2027-02-28");
  });
  it("uses a known year's limits and falls back to the latest with a note", () => {
    expect(limitsFor("2026-27").section80CCD1BPaise).toBe(50_000_00);
    expect(limitsFor("2030-31").sourceNote).toMatch(/No limits recorded for FY 2030-31/);
    expect(limitsFor("2026-27").sourceNote).toMatch(/Unverified/);
  });
});

describe("windows", () => {
  it("reads settings defensively", () => {
    expect(parseTaxSettings({})).toEqual(DEFAULT_TAX_SETTINGS);
    expect(parseTaxSettings({ editWindow: { mode: "monthly", fromDay: 1, toDay: 10 }, declarationCutoff: null, proofWindow: null, lateJoinerDays: 0 }))
      .toEqual({ editWindow: { mode: "monthly", fromDay: 1, toDay: 10 }, declarationCutoff: null, proofWindow: null, lateJoinerDays: 0 });
    expect(parseTaxSettings({ editWindow: { mode: "monthly", fromDay: 20, toDay: 10 }, lateJoinerDays: -1 }).editWindow).toEqual({ mode: "always" });
    expect(checkTaxSettings({ ...DEFAULT_TAX_SETTINGS, proofWindow: { opens: "03-01", closes: "01-31" } })).toMatchObject({ ok: false, field: "proofWindow" });
    expect(checkTaxSettings({ ...DEFAULT_TAX_SETTINGS, editWindow: { mode: "monthly", fromDay: 10, toDay: 5 } })).toMatchObject({ ok: false, field: "toDay" });
    expect(checkTaxSettings({ ...DEFAULT_TAX_SETTINGS, lateJoinerDays: 0 })).toMatchObject({ ok: true });
    expect(checkTaxSettings({ ...DEFAULT_TAX_SETTINGS, lateJoinerDays: 181 })).toMatchObject({ ok: false });
  });
  it("opens declarations until the yearly cut-off, then closes them", () => {
    const s = DEFAULT_TAX_SETTINGS; // always open, cut-off 15 Jan
    expect(declarationWindow(s, FY, "2026-10-30")).toMatchObject({ open: true, until: "2027-01-15" });
    expect(declarationWindow(s, FY, "2027-01-16")).toMatchObject({ open: false, reason: "cutoff_passed" });
    expect(declarationWindow(s, FY, "2027-04-01")).toMatchObject({ open: false, reason: "year_over" });
    expect(declarationWindow(s, "2027-04-01", "2027-02-27")).toMatchObject({ open: false, reason: "not_started", opensOn: "2027-03-01" });
    expect(declarationWindow(s, "2027-04-01", "2027-03-05")).toMatchObject({ open: true });
  });
  it("respects a monthly window and lets late joiners in", () => {
    const s = { ...DEFAULT_TAX_SETTINGS, editWindow: { mode: "monthly" as const, fromDay: 1, toDay: 10 } };
    expect(declarationWindow(s, FY, "2026-10-05")).toMatchObject({ open: true, until: "2026-10-10" });
    expect(declarationWindow(s, FY, "2026-10-30")).toMatchObject({ open: false, reason: "monthly_closed", opensOn: "2026-11-01" });
    expect(declarationWindow(s, FY, "2026-10-30", "2026-10-20")).toMatchObject({ open: true, reason: "late_joiner", until: "2026-11-19" });
    expect(declarationWindow(s, FY, "2027-01-30", "2027-01-20")).toMatchObject({ open: true, reason: "late_joiner" });
    expect(declarationWindow(s, FY, "2026-10-30", "2025-01-01")).toMatchObject({ open: false });
  });
  it("opens proofs in their window and makes them final after it", () => {
    const s = DEFAULT_TAX_SETTINGS; // 1 Jan – 28 Feb
    expect(proofWindow(s, FY, "2026-12-31")).toMatchObject({ open: false, reason: "not_open_yet", opensOn: "2027-01-01" });
    expect(proofWindow(s, FY, "2027-02-28")).toMatchObject({ open: true });
    expect(proofWindow(s, FY, "2027-03-01")).toMatchObject({ open: false, reason: "closed" });
    expect(proofWindow({ ...s, proofWindow: null }, FY, "2026-05-01")).toMatchObject({ open: true });
    expect(proofsFinal(s, FY, "2027-02-28")).toBe(false);
    expect(proofsFinal(s, FY, "2027-03-01")).toBe(true);
  });
});

describe("what counts", () => {
  const row = (section: string, item: string, declaredPaise: number, proofStatus: ItemRow["proofStatus"] = "not_submitted", acceptedPaise: number | null = null): ItemRow =>
    ({ section, item, declaredPaise, acceptedPaise, proofStatus });
  it("uses declared amounts until a proof is checked, then the accepted amount", () => {
    expect(countedPaise(row("80C", "ppf", 1000))).toBe(1000);
    expect(countedPaise(row("80C", "ppf", 1000, "submitted"))).toBe(1000);
    expect(countedPaise(row("80C", "ppf", 1000, "partially_accepted", 600))).toBe(600);
    expect(countedPaise(row("80C", "ppf", 1000, "rejected", 0))).toBe(0);
    expect(countedPaise(row("80C", "ppf", 1000, "submitted"), true)).toBe(0);
    expect(countedPaise(row("80C", "ppf", 1000, "accepted", 1000), true)).toBe(1000);
  });
  it("caps 80D by bucket, with the senior limit when anyone in it is 60+", () => {
    const d = L.section80D;
    expect(capped80D([{ item: "self_family", paise: 30_000_00 }, { item: "preventive_checkup", paise: 7_000_00 }], d)).toEqual({ familyPaise: 25_000_00, parentsPaise: 0, totalPaise: 25_000_00 });
    expect(capped80D([{ item: "self_family", paise: 18_000_00 }, { item: "preventive_checkup", paise: 7_000_00 }], d).familyPaise).toBe(23_000_00);
    expect(capped80D([{ item: "parents_senior", paise: 60_000_00 }, { item: "self_family", paise: 10_000_00 }], d)).toEqual({ familyPaise: 10_000_00, parentsPaise: 50_000_00, totalPaise: 60_000_00 });
  });
  it("totals sections, capping 80CCD(1B) and leaving 80C to the tax engine", () => {
    const t = sectionTotals([
      row("80C", "ppf", 1_00_000_00), row("80C", "elss", 80_000_00, "partially_accepted", 50_000_00),
      row("80CCD1B", "nps_additional", 70_000_00), row("80E", "education_loan_interest", 90_000_00),
      row("24B", "home_loan_interest", 2_50_000_00), row("HRA", "rent_a", 3_00_000_00),
    ], L);
    expect(t).toEqual({ section80CPaise: 1_50_000_00, section80DPaise: 0, section80CCD1BPaise: 50_000_00, section80EPaise: 90_000_00, homeLoanInterestPaise: 2_50_000_00, rentPaise: 3_00_000_00 });
    expect(toTaxDeductions(t, 1_20_000_00, { employeePfPaise: 21_600_00 })).toEqual({
      section80CPaise: 1_71_600_00, otherChapterVIAPaise: 1_40_000_00, hraExemptPaise: 1_20_000_00, homeLoanInterestPaise: 2_50_000_00, professionalTaxPaise: 0,
    });
  });
  it("knows its items", () => {
    expect(isKnownItem("80C", "ppf")).toBe(true);
    expect(isKnownItem("80C", "nope")).toBe(false);
    expect(isKnownItem("HRA", "rent_ab12")).toBe(true);
    expect(isKnownItem("HRA", "rent_../x")).toBe(false);
    expect(isKnownItem("24B", "home_loan_interest")).toBe(true);
  });
});

describe("HRA exemption (golden)", () => {
  const rent = (o: Partial<RentPeriod>): RentPeriod => ({ id: "a", fromMonth: "2026-04-01", toMonth: "2027-03-01", monthlyRentPaise: 20_000_00, landlordName: "R. Shah", landlordPan: "ABCPS1234K", landlordAddress: "Pune", city: "Pune", metro: false, ...o });
  it("takes the least of the three rules each month", () => {
    // basic ₹50,000, HRA ₹20,000, rent ₹20,000, not a metro: (a) 20,000 (b) 20,000 − 5,000 = 15,000 (c) 40% = 20,000 → 15,000 a month
    const months = rentByMonth([rent({})], FY).map((m) => ({ ...m, hraPaise: 20_000_00, basicPaise: 50_000_00 }));
    const r = hraExemption(months, L);
    expect(r.exemptPaise).toBe(1_80_000_00);
    expect(r.byMonth.every((m) => m.rule === "rent_over_salary" && m.exemptPaise === 15_000_00)).toBe(true);
  });
  it("caps at the HRA received or the metro share, and is nothing without rent", () => {
    const one = (o: { hra: number; basic: number; rent: number; metro: boolean }) => hraExemption([{ month: "2026-04-01", hraPaise: o.hra, basicPaise: o.basic, rentPaise: o.rent, metro: o.metro }], L);
    expect(one({ hra: 10_000_00, basic: 50_000_00, rent: 40_000_00, metro: true })).toMatchObject({ exemptPaise: 10_000_00, byMonth: [{ rule: "hra_received" }] });
    expect(one({ hra: 40_000_00, basic: 50_000_00, rent: 60_000_00, metro: true })).toMatchObject({ exemptPaise: 25_000_00, byMonth: [{ rule: "salary_share" }] });
    expect(one({ hra: 40_000_00, basic: 50_000_00, rent: 60_000_00, metro: false }).exemptPaise).toBe(20_000_00);
    expect(one({ hra: 20_000_00, basic: 50_000_00, rent: 4_000_00, metro: false }).exemptPaise).toBe(0);
    expect(one({ hra: 20_000_00, basic: 50_000_00, rent: 0, metro: false }).exemptPaise).toBe(0);
  });
  it("rounds once, to the rupee, after summing exact months", () => {
    // rent − 10% of basic = 12,345.67 − 3,333.33 = 9,012.34 → over 3 months 27,037.02 → ₹27,037
    const m = { hraPaise: 15_000_00, basicPaise: 33_333_33, rentPaise: 12_345_67, metro: false };
    expect(hraExemption([{ month: "2026-04-01", ...m }, { month: "2026-05-01", ...m }, { month: "2026-06-01", ...m }], L).exemptPaise).toBe(27_037_00);
  });
  it("checks rent periods: overlaps, months outside the year, and landlord PAN above ₹1 lakh", () => {
    expect(checkRentPeriods([rent({})], FY, L)).toEqual([]);
    expect(checkRentPeriods([rent({ landlordPan: null })], FY, L)[0]).toMatch(/PAN/);
    expect(checkRentPeriods([rent({ landlordPan: null, monthlyRentPaise: 8_000_00 })], FY, L)).toEqual([]); // ₹96,000 a year
    expect(checkRentPeriods([rent({ toMonth: "2026-09-01" }), rent({ id: "b", fromMonth: "2026-09-01" })], FY, L)).toContain("Two rent periods cover the same month.");
    expect(checkRentPeriods([rent({ toMonth: "2027-04-01" })], FY, L)[0]).toMatch(/inside FY/);
    expect(annualRent([rent({ toMonth: "2026-09-01" }), rent({ id: "b", fromMonth: "2026-10-01", monthlyRentPaise: 25_000_00 })], FY)).toBe(6 * 20_000_00 + 6 * 25_000_00);
  });
});

describe("salary projection", () => {
  const comps = [{ code: "BASIC", kind: "earning", taxable: true }, { code: "HRA", kind: "earning", taxable: true }, { code: "SPECIAL", kind: "earning", taxable: true }, { code: "PF_EMPLOYER", kind: "employer_contribution", taxable: false }];
  it("sums taxable earnings, pro-rating part months", () => {
    const b = { BASIC: 50_000_00, HRA: 20_000_00, SPECIAL: 28_200_00, PF_EMPLOYER: 1_800_00 };
    const r = projectSalary([
      { month: "2026-04-01", breakup: null, days: 0, ofDays: 30 },
      { month: "2026-05-01", breakup: b, ...daysEmployed("2026-05-01", "2026-05-17", null) },
      { month: "2026-06-01", breakup: b, ...daysEmployed("2026-06-01", "2026-05-17", null) },
    ], comps);
    expect(daysEmployed("2026-05-01", "2026-05-17", null)).toEqual({ days: 15, ofDays: 31 });
    expect(daysEmployed("2026-06-01", "2026-05-17", "2026-06-10")).toEqual({ days: 10, ofDays: 30 });
    expect(daysEmployed("2026-07-01", "2026-05-17", "2026-06-10")).toEqual({ days: 0, ofDays: 31 });
    // May: 15/31 of each line, half-up per line
    expect(r.months[1]).toEqual({ month: "2026-05-01", taxablePaise: 24_193_55 + 9_677_42 + 13_645_16, hraPaise: 9_677_42, basicPaise: 24_193_55, pfEmployerPaise: 870_97 });
    expect(r.taxablePaise).toBe(24_193_55 + 9_677_42 + 13_645_16 + 98_200_00);
  });
});

describe("regime comparison on declarations (golden, unverified rates)", () => {
  it("old regime wins with large deductions, new regime with none", () => {
    const gross = 15_00_000_00;
    const d = toTaxDeductions({ section80CPaise: 1_50_000_00, section80DPaise: 25_000_00, section80CCD1BPaise: 50_000_00, section80EPaise: 0, homeLoanInterestPaise: 2_00_000_00, rentPaise: 0 }, 0);
    const withDeductions = compareRegimes({ oldConfig: taxConfig("old"), newConfig: taxConfig("new"), grossIncomePaise: gross, deductions: d });
    const none = compareRegimes({ oldConfig: taxConfig("old"), newConfig: taxConfig("new"), grossIncomePaise: gross, deductions: {} });
    expect(none.better).toBe("new");
    expect(withDeductions.old.totalTaxPaise).toBeLessThan(none.old.totalTaxPaise);
    expect(withDeductions.new.totalTaxPaise).toBe(none.new.totalTaxPaise); // new regime ignores these
    expect(annualTax({ config: taxConfig("old"), grossIncomePaise: gross, deductions: d }).deductionsPaise).toBe(1_50_000_00 + 75_000_00 + 2_00_000_00);
  });
});

describe("PAN and Form 16 files", () => {
  it("validates PANs and reads them from file names", () => {
    expect(isPan("abcde1234f")).toBe(true);
    expect(isPan("ABCDE12345")).toBe(false);
    expect(panFromFileName("ABCDE1234F.pdf")).toBe("ABCDE1234F");
    expect(panFromFileName("abcde1234f_2025-26_PartA.PDF")).toBe("ABCDE1234F");
    expect(panFromFileName("folder/ABCDE1234F-form16.pdf")).toBe("ABCDE1234F");
    expect(panFromFileName("ABCDE1234FX.pdf")).toBeNull();
    expect(panFromFileName("Form16_ABCDE1234F.pdf")).toBeNull();
  });
  it("parses rupees exactly", () => {
    expect(parseRupees("1,50,000.5")).toBe(1_50_000_50);
    expect(parseRupees("₹ 12")).toBe(12_00);
    expect(parseRupees("")).toBe(0);
    expect(parseRupees("1.234")).toBeNull();
    expect(parseRupees("-5")).toBeNull();
    expect(parseRupees(0.1)).toBe(10);
  });
});

describe("zip reader", () => {
  const pdf = new TextEncoder().encode("%PDF-1.4 hello");
  it("reads stored and deflated entries, skipping folders and macOS metadata", () => {
    const z = writeZip([{ name: "ABCDE1234F.pdf", bytes: pdf }, { name: "sub/", bytes: new Uint8Array() }, { name: "__MACOSX/._x", bytes: pdf }, { name: "sub/PQRST6789Z.pdf", bytes: pdf, deflate: true }]);
    const e = readZip(z);
    expect(e.map((x) => x.name)).toEqual(["ABCDE1234F.pdf", "PQRST6789Z.pdf"]);
    expect(new TextDecoder().decode(e[1].bytes)).toBe("%PDF-1.4 hello");
  });
  it("refuses non-zips, damaged archives and too many or too large files", () => {
    expect(() => readZip(pdf)).toThrow(ZipError);
    const z = writeZip([{ name: "a.pdf", bytes: pdf }, { name: "b.pdf", bytes: pdf }]);
    expect(() => readZip(z.slice(0, z.length - 30))).toThrow(ZipError);
    expect(() => readZip(z, { maxEntries: 1, maxEntryBytes: 1e6, maxTotalBytes: 1e6 })).toThrow(/at most 1/);
    expect(() => readZip(z, { maxEntries: 10, maxEntryBytes: 5, maxTotalBytes: 1e6 })).toThrow(/larger than/);
    const big = writeZip([{ name: "a.pdf", bytes: new Uint8Array(100_000), deflate: true }]);
    expect(() => readZip(big, { maxEntries: 10, maxEntryBytes: 1e6, maxTotalBytes: 50_000 })).toThrow(/too large/);
  });
});
