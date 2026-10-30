/**
 * Shapes of the statutory_rates.config JSON, one per kind. Pure (no I/O): shared by the engine, the seed data,
 * the DB loader (which validates every row it reads) and the settings page.
 *
 * Units: money is integer paise; percentages are basis points (1% = 100 bp, 8.33% = 833 bp).
 * Upper bounds of slabs are inclusive; `null` means "and above".
 */
import { z } from "zod";

const paise = z.number().int().nonnegative();
const bp = z.number().int().min(0).max(10_000);
const month = z.number().int().min(1).max(12);

export const pfConfig = z.object({
  employeeBp: bp,                 // employee share of PF wages
  employerBp: bp,                 // employer share (EPS + EPF together)
  epsBp: bp,                      // pension part of the employer share
  wageCeilingPaise: paise,        // PF wages are capped here unless the company contributes on full wages
  epsMaxPaise: paise,             // EPS is never more than this, even on full wages
  adminChargeBp: bp,              // employer-only admin charge on the PF wages contributed on
  edliBp: bp,                     // employer-only insurance contribution
  edliWageCeilingPaise: paise,
});
export type PfConfig = z.infer<typeof pfConfig>;

export const esiConfig = z.object({
  employeeBp: bp,
  employerBp: bp,
  wageCeilingPaise: paise,          // covered if gross wages are at or below this
  disabledWageCeilingPaise: paise,  // higher ceiling for persons with disability
  employeeExemptDailyWagePaise: paise, // at or below this average daily wage the employee share is nil (employer still pays)
  periodStartMonths: z.array(month).min(1), // contribution periods start in these months (Apr, Oct)
});
export type EsiConfig = z.infer<typeof esiConfig>;

export const ptSlab = z.object({ upToPaise: paise.nullable(), amountPaise: paise, februaryAmountPaise: paise.optional() });
export type PtSlab = z.infer<typeof ptSlab>;
export const ptConfig = z.object({
  stateName: z.string(),
  period: z.enum(["monthly", "half_yearly"]),
  deductMonths: z.array(month).optional(),   // half-yearly states deduct only in these months
  slabs: z.array(ptSlab).min(1),             // on monthly gross (monthly) or the period's gross (half-yearly)
  femaleSlabs: z.array(ptSlab).optional(),   // where women have their own table
  annualCapPaise: paise,                     // never more than this in a financial year
});
export type PtConfig = z.infer<typeof ptConfig>;

export const lwfSlab = z.object({ upToPaise: paise.nullable(), employeePaise: paise, employerPaise: paise });
export const lwfConfig = z.object({
  stateName: z.string(),
  frequency: z.enum(["monthly", "half_yearly", "yearly"]),
  deductMonths: z.array(month).min(1),
  slabs: z.array(lwfSlab).min(1),            // on that month's gross
});
export type LwfConfig = z.infer<typeof lwfConfig>;

export const gratuityConfig = z.object({
  daysPerYear: z.number().int().positive(),       // 15 days' wages per year of service …
  monthDivisor: z.number().int().positive(),      // … where a day's wage is monthly wages / 26
  minYears: z.number().int().nonnegative(),       // continuous service needed (not for death/disablement)
  fixedTermMinYears: z.number().int().nonnegative(),
  roundUpAfterMonths: z.number().int().min(0).max(11), // a part year of more than this many months counts as a year
  exemptionCapPaise: paise,                       // statutory ceiling / tax exemption limit
});
export type GratuityConfig = z.infer<typeof gratuityConfig>;

export const AGE_BANDS = ["below_60", "senior", "super_senior"] as const;
export type AgeBand = (typeof AGE_BANDS)[number];
export const taxSlab = z.object({ upToPaise: paise.nullable(), rateBp: bp });
export type TaxSlab = z.infer<typeof taxSlab>;
export const incomeTaxConfig = z.object({
  fy: z.string().regex(/^\d{4}-\d{2}$/),
  regime: z.enum(["old", "new"]),
  slabs: z.object({ below_60: z.array(taxSlab).min(1), senior: z.array(taxSlab).min(1), super_senior: z.array(taxSlab).min(1) }),
  standardDeductionPaise: paise,
  rebate: z.object({ maxIncomePaise: paise, maxRebatePaise: paise, marginalRelief: z.boolean() }),
  surcharge: z.array(z.object({ overPaise: paise, rateBp: bp })),   // ascending thresholds
  cessBp: bp,
  /** "all": every declared deduction counts (old regime). "limited": only employer NPS (new regime). */
  deductions: z.enum(["all", "limited"]),
  caps: z.object({ section80CPaise: paise, homeLoanInterestPaise: paise, professionalTaxPaise: paise }),
});
export type IncomeTaxConfig = z.infer<typeof incomeTaxConfig>;

export const CONFIG_SCHEMAS = { pf: pfConfig, esi: esiConfig, pt: ptConfig, lwf: lwfConfig, gratuity: gratuityConfig, income_tax: incomeTaxConfig } as const;
export type RateKind = keyof typeof CONFIG_SCHEMAS;
export const RATE_KINDS = Object.keys(CONFIG_SCHEMAS) as RateKind[];

/** One versioned row as stored in statutory_rates (config validated against its kind). */
export type RateRow<K extends RateKind = RateKind> = {
  kind: K;
  stateCode: string | null;
  regime: "old" | "new" | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  config: z.infer<(typeof CONFIG_SCHEMAS)[K]>;
  sourceNote: string;
};

/** States with PT and LWF data in erp. */
export const STATES = { KA: "Karnataka", MH: "Maharashtra", TN: "Tamil Nadu", WB: "West Bengal", AP: "Andhra Pradesh", TS: "Telangana", GJ: "Gujarat", MP: "Madhya Pradesh" } as const;
export type StateCode = keyof typeof STATES;
