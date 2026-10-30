/**
 * erp's statutory rate tables, as data. This file is the source that `syncStatutoryRates()` writes into the global
 * statutory_rates table; the payroll engine only ever reads the table (via loadRates), never this file.
 *
 * EVERY number here comes from general knowledge of Indian law and has NOT been checked by a chartered accountant.
 * Each row carries that warning in its source note, and the product shows a banner until a company records a CA
 * verification. Change a number here, run `pnpm jobs:statutory-rates`, and every company sees the banner again.
 */
import type { IncomeTaxConfig, LwfConfig, PtConfig, RateRow, StateCode, TaxSlab } from "./config";
import { STATES } from "./config";

export const UNVERIFIED = "Unverified — confirm with a CA before running live payroll.";
export const ASSUMED_SAME = "Assumed same as previous year — verify.";

const R = (rupees: number) => Math.round(rupees * 100);   // rupees → paise (data entry helper only)
const LAKH = 100_000;

// ---------------------------------------------------------------- PF / ESI / gratuity
const pf: RateRow<"pf"> = {
  kind: "pf", stateCode: null, regime: null, effectiveFrom: "2014-09-01", effectiveTo: null,
  config: { employeeBp: 1200, employerBp: 1200, epsBp: 833, wageCeilingPaise: R(15_000), epsMaxPaise: R(1_250), adminChargeBp: 50, edliBp: 50, edliWageCeilingPaise: R(15_000) },
  sourceNote: `EPF & MP Act 1952 as generally understood: 12% + 12% on PF wages up to ₹15,000 (unless contributing on full wages); employer EPS 8.33% capped at ₹1,250; admin 0.5%; EDLI 0.5% on wages up to ₹15,000. ${UNVERIFIED}`,
};

const esi: RateRow<"esi"> = {
  kind: "esi", stateCode: null, regime: null, effectiveFrom: "2019-07-01", effectiveTo: null,
  config: { employeeBp: 75, employerBp: 325, wageCeilingPaise: R(21_000), disabledWageCeilingPaise: R(25_000), employeeExemptDailyWagePaise: R(176), periodStartMonths: [4, 10] },
  sourceNote: `ESI Act 1948 as generally understood: 0.75% employee + 3.25% employer when gross wages are ₹21,000 or less (₹25,000 for persons with disability); contribution periods Apr–Sep and Oct–Mar keep coverage for the whole period; contributions rounded up to the next rupee. ${UNVERIFIED}`,
};

const gratuity: RateRow<"gratuity"> = {
  kind: "gratuity", stateCode: null, regime: null, effectiveFrom: "2018-03-29", effectiveTo: null,
  config: { daysPerYear: 15, monthDivisor: 26, minYears: 5, fixedTermMinYears: 1, roundUpAfterMonths: 6, exemptionCapPaise: R(20 * LAKH) },
  sourceNote: `Payment of Gratuity Act 1972 as generally understood: 15/26 × last drawn basic + DA × completed years (a part year over six months counts), after five years of continuous service (not needed on death or disablement; one year for fixed-term staff under the Code on Social Security); ₹20 lakh ceiling and tax exemption. ${UNVERIFIED}`,
};

// ---------------------------------------------------------------- Professional tax
const pt = (code: StateCode, c: Omit<PtConfig, "stateName">, note: string): RateRow<"pt"> => ({
  kind: "pt", stateCode: code, regime: null, effectiveFrom: "2025-04-01", effectiveTo: null,
  config: { stateName: STATES[code], ...c }, sourceNote: `${STATES[code]} professional tax as generally understood: ${note} ${UNVERIFIED}`,
});
const ptRows: RateRow<"pt">[] = [
  pt("KA", { period: "monthly", annualCapPaise: R(2_500), slabs: [{ upToPaise: R(24_999.99), amountPaise: 0 }, { upToPaise: null, amountPaise: R(200), februaryAmountPaise: R(300) }] },
    "₹200 a month from ₹25,000 gross, ₹300 in February; ₹2,500 a year at most."),
  pt("MH", {
    period: "monthly", annualCapPaise: R(2_500),
    slabs: [{ upToPaise: R(7_500), amountPaise: 0 }, { upToPaise: R(10_000), amountPaise: R(175) }, { upToPaise: null, amountPaise: R(200), februaryAmountPaise: R(300) }],
    femaleSlabs: [{ upToPaise: R(25_000), amountPaise: 0 }, { upToPaise: null, amountPaise: R(200), februaryAmountPaise: R(300) }],
  }, "men ₹175 above ₹7,500 and ₹200 above ₹10,000; women ₹200 above ₹25,000; ₹300 in February; ₹2,500 a year at most."),
  pt("TN", {
    period: "half_yearly", deductMonths: [9, 3], annualCapPaise: R(2_500),
    slabs: [{ upToPaise: R(21_000), amountPaise: 0 }, { upToPaise: R(30_000), amountPaise: R(180) }, { upToPaise: R(45_000), amountPaise: R(425) },
      { upToPaise: R(60_000), amountPaise: R(930) }, { upToPaise: R(75_000), amountPaise: R(1_025) }, { upToPaise: null, amountPaise: R(1_250) }],
  }, "half-yearly on the half-year's gross (Apr–Sep, Oct–Mar), deducted in September and March; ₹1,250 per half year at most."),
  pt("WB", { period: "monthly", annualCapPaise: R(2_500), slabs: [{ upToPaise: R(10_000), amountPaise: 0 }, { upToPaise: R(15_000), amountPaise: R(110) }, { upToPaise: R(25_000), amountPaise: R(130) }, { upToPaise: R(40_000), amountPaise: R(150) }, { upToPaise: null, amountPaise: R(200) }] },
    "₹110 / ₹130 / ₹150 / ₹200 a month above ₹10,000 / ₹15,000 / ₹25,000 / ₹40,000."),
  pt("AP", { period: "monthly", annualCapPaise: R(2_500), slabs: [{ upToPaise: R(15_000), amountPaise: 0 }, { upToPaise: R(20_000), amountPaise: R(150) }, { upToPaise: null, amountPaise: R(200) }] },
    "₹150 a month above ₹15,000 and ₹200 above ₹20,000."),
  pt("TS", { period: "monthly", annualCapPaise: R(2_500), slabs: [{ upToPaise: R(15_000), amountPaise: 0 }, { upToPaise: R(20_000), amountPaise: R(150) }, { upToPaise: null, amountPaise: R(200) }] },
    "₹150 a month above ₹15,000 and ₹200 above ₹20,000."),
  pt("GJ", { period: "monthly", annualCapPaise: R(2_500), slabs: [{ upToPaise: R(11_999.99), amountPaise: 0 }, { upToPaise: null, amountPaise: R(200) }] },
    "₹200 a month from ₹12,000 gross."),
  pt("MP", { period: "monthly", annualCapPaise: R(2_500),
    slabs: [{ upToPaise: R(18_750), amountPaise: 0 }, { upToPaise: R(25_000), amountPaise: R(125) }, { upToPaise: R(33_333), amountPaise: R(166), februaryAmountPaise: R(174) }, { upToPaise: null, amountPaise: R(208), februaryAmountPaise: R(212) }] },
    "on annual income above ₹2.25 lakh / ₹3 lakh / ₹4 lakh: ₹1,500 / ₹2,000 / ₹2,500 a year, spread monthly with the balance in February."),
];

// ---------------------------------------------------------------- Labour welfare fund
const lwf = (code: StateCode, c: Omit<LwfConfig, "stateName">, note: string): RateRow<"lwf"> => ({
  kind: "lwf", stateCode: code, regime: null, effectiveFrom: "2025-04-01", effectiveTo: null,
  config: { stateName: STATES[code], ...c }, sourceNote: `${STATES[code]} labour welfare fund as generally understood: ${note} ${UNVERIFIED}`,
});
const flat = (ee: number, er: number) => [{ upToPaise: null, employeePaise: R(ee), employerPaise: R(er) }];
const lwfRows: RateRow<"lwf">[] = [
  lwf("KA", { frequency: "yearly", deductMonths: [12], slabs: flat(50, 100) }, "₹50 employee + ₹100 employer once a year, with December's salary."),
  lwf("MH", { frequency: "half_yearly", deductMonths: [6, 12], slabs: [{ upToPaise: R(3_000), employeePaise: R(6), employerPaise: R(18) }, { upToPaise: null, employeePaise: R(25), employerPaise: R(75) }] },
    "₹25 employee + ₹75 employer in June and December (₹6 + ₹18 on wages up to ₹3,000)."),
  lwf("TN", { frequency: "yearly", deductMonths: [12], slabs: flat(20, 40) }, "₹20 employee + ₹40 employer once a year, with December's salary."),
  lwf("WB", { frequency: "half_yearly", deductMonths: [6, 12], slabs: flat(3, 15) }, "₹3 employee + ₹15 employer in June and December."),
  lwf("AP", { frequency: "yearly", deductMonths: [12], slabs: flat(30, 70) }, "₹30 employee + ₹70 employer once a year, with December's salary."),
  lwf("TS", { frequency: "yearly", deductMonths: [12], slabs: flat(2, 5) }, "₹2 employee + ₹5 employer once a year, with December's salary."),
  lwf("GJ", { frequency: "half_yearly", deductMonths: [6, 12], slabs: flat(6, 12) }, "₹6 employee + ₹12 employer in June and December."),
  lwf("MP", { frequency: "half_yearly", deductMonths: [6, 12], slabs: flat(10, 30) }, "₹10 employee + ₹30 employer in June and December."),
];

// ---------------------------------------------------------------- Income tax (data driven per FY and regime)
const slabs = (pairs: [number | null, number][]): TaxSlab[] => pairs.map(([upTo, pct]) => ({ upToPaise: upTo == null ? null : R(upTo), rateBp: pct * 100 }));
const sameForAll = (s: TaxSlab[]) => ({ below_60: s, senior: s, super_senior: s });
const CAPS = { section80CPaise: R(1.5 * LAKH), homeLoanInterestPaise: R(2 * LAKH), professionalTaxPaise: R(2_500) };

const NEW_2025: IncomeTaxConfig = {
  fy: "2025-26", regime: "new",
  slabs: sameForAll(slabs([[4 * LAKH, 0], [8 * LAKH, 5], [12 * LAKH, 10], [16 * LAKH, 15], [20 * LAKH, 20], [24 * LAKH, 25], [null, 30]])),
  standardDeductionPaise: R(75_000),
  rebate: { maxIncomePaise: R(12 * LAKH), maxRebatePaise: R(60_000), marginalRelief: true },
  surcharge: [{ overPaise: R(50 * LAKH), rateBp: 1000 }, { overPaise: R(100 * LAKH), rateBp: 1500 }, { overPaise: R(200 * LAKH), rateBp: 2500 }],
  cessBp: 400, deductions: "limited", caps: CAPS,
};
const OLD_2025: IncomeTaxConfig = {
  fy: "2025-26", regime: "old",
  slabs: {
    below_60: slabs([[2.5 * LAKH, 0], [5 * LAKH, 5], [10 * LAKH, 20], [null, 30]]),
    senior: slabs([[3 * LAKH, 0], [5 * LAKH, 5], [10 * LAKH, 20], [null, 30]]),
    super_senior: slabs([[5 * LAKH, 0], [10 * LAKH, 20], [null, 30]]),
  },
  standardDeductionPaise: R(50_000),
  rebate: { maxIncomePaise: R(5 * LAKH), maxRebatePaise: R(12_500), marginalRelief: false },
  surcharge: [{ overPaise: R(50 * LAKH), rateBp: 1000 }, { overPaise: R(100 * LAKH), rateBp: 1500 }, { overPaise: R(200 * LAKH), rateBp: 2500 }, { overPaise: R(500 * LAKH), rateBp: 3700 }],
  cessBp: 400, deductions: "all", caps: CAPS,
};
const tax = (c: IncomeTaxConfig, from: string, to: string, note: string): RateRow<"income_tax"> =>
  ({ kind: "income_tax", stateCode: null, regime: c.regime, effectiveFrom: from, effectiveTo: to, config: c, sourceNote: note });
const taxRows: RateRow<"income_tax">[] = [
  tax(NEW_2025, "2025-04-01", "2026-03-31", `FY 2025-26 new regime (section 115BAC) as generally understood: slabs of ₹4 lakh steps from 5% to 30%, standard deduction ₹75,000, rebate up to ₹60,000 to ₹12 lakh with marginal relief, surcharge 10/15/25%, 4% cess. ${UNVERIFIED}`),
  tax(OLD_2025, "2025-04-01", "2026-03-31", `FY 2025-26 old regime as generally understood: 5/20/30% slabs (higher exemption for seniors), standard deduction ₹50,000, rebate up to ₹12,500 to ₹5 lakh, surcharge 10/15/25/37%, 4% cess. ${UNVERIFIED}`),
  tax({ ...NEW_2025, fy: "2026-27" }, "2026-04-01", "2027-03-31", `FY 2026-27 new regime: ${ASSUMED_SAME} ${UNVERIFIED}`),
  tax({ ...OLD_2025, fy: "2026-27" }, "2026-04-01", "2027-03-31", `FY 2026-27 old regime: ${ASSUMED_SAME} ${UNVERIFIED}`),
];

export const RATE_ROWS: RateRow[] = [pf, esi, gratuity, ...ptRows, ...lwfRows, ...taxRows];
