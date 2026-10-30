/**
 * Income-tax declarations: sections and items, the declaration limits erp applies, HRA exemption, the yearly salary
 * projection, declaration and proof windows, PAN checks and Form 16 file matching. Pure: no I/O, no clock.
 *
 * UNVERIFIED: every limit below (80D, 80CCD(1B), the HRA percentages, the ₹1 lakh landlord-PAN threshold) comes from
 * general knowledge of the Income-tax Act and has not been checked by a chartered accountant. The 80C and home-loan
 * interest caps come from the statutory module's income-tax rates (also unverified). Confirm with a CA before relying
 * on any of it for live payroll.
 */
import type { TaxDeductions } from "@/server/modules/statutory/rules";

export const UNVERIFIED_NOTE = "Unverified — general knowledge of the Income-tax Act, not checked by a CA. Confirm with a CA before running live payroll.";

// ---------------------------------------------------------------- sections and items
export const SECTIONS = ["80C", "80D", "80CCD1B", "80E", "24B", "HRA"] as const;
export type Section = (typeof SECTIONS)[number];

export const SECTION_LABEL: Record<Section, string> = {
  "80C": "Section 80C investments", "80D": "Section 80D health insurance", "80CCD1B": "Section 80CCD(1B) extra NPS",
  "80E": "Section 80E education loan", "24B": "Section 24(b) home loan interest", HRA: "House rent (HRA)",
};

/** Items people pick from in each Chapter VI-A section. HRA items are rent periods; 24(b) has one item. */
export const ITEMS: Record<"80C" | "80D" | "80CCD1B" | "80E", { key: string; label: string; hint?: string }[]> = {
  "80C": [
    { key: "life_insurance", label: "Life insurance premiums" },
    { key: "ppf", label: "Public Provident Fund (PPF)" },
    { key: "elss", label: "Tax-saving mutual funds (ELSS)" },
    { key: "nsc", label: "National Savings Certificates" },
    { key: "tuition_fees", label: "Children's tuition fees", hint: "Up to two children, full-time education in India" },
    { key: "home_loan_principal", label: "Home loan principal repaid" },
    { key: "sukanya", label: "Sukanya Samriddhi account" },
    { key: "tax_saver_fd", label: "5-year tax-saving bank deposit" },
    { key: "nps_own", label: "NPS, your own contribution (80CCD(1))" },
    { key: "other_80c", label: "Other 80C investment" },
  ],
  "80D": [
    { key: "self_family", label: "Health insurance for you, spouse and children" },
    { key: "self_family_senior", label: "Same, if you or your spouse is 60 or older", hint: "Use this instead of the line above" },
    { key: "preventive_checkup", label: "Preventive health check-ups", hint: "Counts within your family's limit" },
    { key: "parents", label: "Health insurance for your parents" },
    { key: "parents_senior", label: "Same, if a parent is 60 or older", hint: "Use this instead of the line above" },
  ],
  "80CCD1B": [{ key: "nps_additional", label: "Additional NPS contribution (Tier I)" }],
  "80E": [{ key: "education_loan_interest", label: "Interest on an education loan", hint: "For you, your spouse or children; no upper limit" }],
};
export const HOME_LOAN_ITEM = "home_loan_interest";

export function itemLabel(section: string, item: string) {
  if (section === "HRA") return "Rent paid";
  if (section === "24B") return "Interest on a home loan";
  return (ITEMS as Record<string, { key: string; label: string }[]>)[section]?.find((i) => i.key === item)?.label ?? item;
}
export const isKnownItem = (section: string, item: string) =>
  section === "HRA" ? /^rent_[a-z0-9]{1,12}$/.test(item) : section === "24B" ? item === HOME_LOAN_ITEM
    : !!(ITEMS as Record<string, { key: string }[]>)[section]?.some((i) => i.key === item);

// ---------------------------------------------------------------- limits (per financial year, unverified)
export type DeclarationLimits = {
  fy: string;
  section80D: { selfFamilyPaise: number; selfFamilySeniorPaise: number; parentsPaise: number; parentsSeniorPaise: number; preventiveCheckupPaise: number };
  section80CCD1BPaise: number;
  hra: { metroBp: number; nonMetroBp: number; rentOverSalaryBp: number; landlordPanAboveAnnualPaise: number };
  sourceNote: string;
};
const L2025: DeclarationLimits = {
  fy: "2025-26",
  section80D: { selfFamilyPaise: 25_000_00, selfFamilySeniorPaise: 50_000_00, parentsPaise: 25_000_00, parentsSeniorPaise: 50_000_00, preventiveCheckupPaise: 5_000_00 },
  section80CCD1BPaise: 50_000_00,
  hra: { metroBp: 5000, nonMetroBp: 4000, rentOverSalaryBp: 1000, landlordPanAboveAnnualPaise: 1_00_000_00 },
  sourceNote: `80D ₹25,000 / ₹50,000 (seniors) each for family and parents, check-ups ₹5,000 within those; 80CCD(1B) ₹50,000; HRA least of actual HRA, rent − 10% of salary, 50% (metro) / 40% of salary; landlord PAN above ₹1 lakh rent a year. ${UNVERIFIED_NOTE}`,
};
export const DECLARATION_LIMITS: Record<string, DeclarationLimits> = {
  "2025-26": L2025,
  "2026-27": { ...L2025, fy: "2026-27", sourceNote: `Assumed the same as FY 2025-26. ${L2025.sourceNote}` },
};
/** Limits for a financial year; years erp has no data for reuse the latest one (and say so in the note). */
export function limitsFor(fy: string): DeclarationLimits {
  if (DECLARATION_LIMITS[fy]) return DECLARATION_LIMITS[fy];
  const latest = Object.keys(DECLARATION_LIMITS).sort().at(-1)!;
  return { ...DECLARATION_LIMITS[latest], fy, sourceNote: `No limits recorded for FY ${fy}; using FY ${latest}'s. ${DECLARATION_LIMITS[latest].sourceNote}` };
}

// ---------------------------------------------------------------- financial years
export const fyStartOf = (date: string) => { const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7)); return `${m >= 4 ? y : y - 1}-04-01`; };
export const fyLabel = (fyStart: string) => { const y = Number(fyStart.slice(0, 4)); return `${y}-${String((y + 1) % 100).padStart(2, "0")}`; };
export const fyStartFromLabel = (fy: string) => (/^\d{4}-\d{2}$/.test(fy) && (Number(fy.slice(0, 4)) + 1) % 100 === Number(fy.slice(5)) ? `${fy.slice(0, 4)}-04-01` : null);
export const fyEnd = (fyStart: string) => `${Number(fyStart.slice(0, 4)) + 1}-03-31`;
export const fyMonths = (fyStart: string) => Array.from({ length: 12 }, (_, i) => {
  const t = Number(fyStart.slice(0, 4)) * 12 + 3 + i;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}-01`;
});
const daysInMonth = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
const monthEnd = (month: string) => `${month.slice(0, 8)}${String(daysInMonth(month)).padStart(2, "0")}`;

/** "MM-DD" inside a financial year → the date (Jan–Mar fall in the second calendar year). 29 Feb becomes 28 Feb when needed. */
export function mdInFy(fyStart: string, md: string) {
  const m = Number(md.slice(0, 2)), d = Number(md.slice(3, 5));
  const y = Number(fyStart.slice(0, 4)) + (m < 4 ? 1 : 0);
  const month = `${y}-${String(m).padStart(2, "0")}-01`;
  return `${month.slice(0, 8)}${String(Math.min(d, daysInMonth(month))).padStart(2, "0")}`;
}
const isMd = (s: unknown): s is string => typeof s === "string" && /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(s);
const addDays = (d: string, n: number) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

// ---------------------------------------------------------------- windows (pay group tax settings)
export type TaxSettings = {
  /** when people may change declarations: any time, or only between two days of each month */
  editWindow: { mode: "always" } | { mode: "monthly"; fromDay: number; toDay: number };
  /** "MM-DD" in the financial year after which declarations can't change (null: open all year) */
  declarationCutoff: string | null;
  /** "MM-DD" proof submission window (null: any time in the year) */
  proofWindow: { opens: string; closes: string } | null;
  /** people who joined recently may declare for this many days, whatever the windows say */
  lateJoinerDays: number;
};
export const DEFAULT_TAX_SETTINGS: TaxSettings = { editWindow: { mode: "always" }, declarationCutoff: "01-15", proofWindow: { opens: "01-01", closes: "02-28" }, lateJoinerDays: 30 };

const int = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null);
/** Reads pay_groups.tax_settings, falling back to defaults field by field (bad or missing values never throw). */
export function parseTaxSettings(raw: unknown): TaxSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const ew = (r.editWindow ?? {}) as Record<string, unknown>;
  const from = int(ew.fromDay, 1, 28), to = int(ew.toDay, 1, 31);
  const editWindow: TaxSettings["editWindow"] = ew.mode === "monthly" && from && to && to >= from ? { mode: "monthly", fromDay: from, toDay: to } : ew.mode === "always" ? { mode: "always" } : DEFAULT_TAX_SETTINGS.editWindow;
  const pw = r.proofWindow as Record<string, unknown> | null | undefined;
  const proofWindow = pw === null ? null : pw && isMd(pw.opens) && isMd(pw.closes) ? { opens: pw.opens, closes: pw.closes } : DEFAULT_TAX_SETTINGS.proofWindow;
  return {
    editWindow,
    declarationCutoff: r.declarationCutoff === null ? null : isMd(r.declarationCutoff) ? r.declarationCutoff : DEFAULT_TAX_SETTINGS.declarationCutoff,
    proofWindow,
    lateJoinerDays: int(r.lateJoinerDays, 0, 180) ?? DEFAULT_TAX_SETTINGS.lateJoinerDays,
  };
}

/** Validates settings typed by an admin. Returns a message for the first problem, or the settings. */
export function checkTaxSettings(s: TaxSettings): { ok: true; settings: TaxSettings } | { ok: false; error: string; field: string } {
  if (s.editWindow.mode === "monthly") {
    const { fromDay, toDay } = s.editWindow;
    if (!int(fromDay, 1, 28)) return { ok: false, error: "The monthly window must open on a day from 1 to 28.", field: "fromDay" };
    if (!int(toDay, 1, 31) || toDay < fromDay) return { ok: false, error: "The monthly window must close on or after the day it opens.", field: "toDay" };
  }
  if (s.declarationCutoff !== null && !isMd(s.declarationCutoff)) return { ok: false, error: "Pick the cut-off day and month.", field: "declarationCutoff" };
  if (s.proofWindow) {
    if (!isMd(s.proofWindow.opens) || !isMd(s.proofWindow.closes)) return { ok: false, error: "Pick when proof submission opens and closes.", field: "proofWindow" };
    if (mdInFy("2025-04-01", s.proofWindow.closes) < mdInFy("2025-04-01", s.proofWindow.opens)) return { ok: false, error: "Proof submission must close after it opens (both inside the financial year, April to March).", field: "proofWindow" };
  }
  if (int(s.lateJoinerDays, 0, 180) === null) return { ok: false, error: "Give new joiners 0 to 180 days.", field: "lateJoinerDays" };
  return { ok: true, settings: s };
}

export type WindowState = { open: boolean; reason: "open" | "late_joiner" | "monthly_closed" | "cutoff_passed" | "year_over" | "not_started" | "not_open_yet" | "closed"; until?: string; opensOn?: string; message: string };
const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** Can declarations for the year starting `fyStart` be changed on `today`? Next year's open from 1 March. */
export function declarationWindow(s: TaxSettings, fyStart: string, today: string, joiningDate?: string | null): WindowState {
  const end = fyEnd(fyStart);
  if (today > end) return { open: false, reason: "year_over", message: `FY ${fyLabel(fyStart)} has ended, so its declarations can't change.` };
  const earliest = `${fyStart.slice(0, 4)}-03-01`;
  if (today < earliest) return { open: false, reason: "not_started", opensOn: earliest, message: `Declarations for FY ${fyLabel(fyStart)} open on ${fmt(earliest)}.` };
  if (joiningDate && joiningDate >= fyStart && joiningDate <= end && s.lateJoinerDays > 0) {
    const until = addDays(joiningDate, s.lateJoinerDays);
    if (today <= until) return { open: true, reason: "late_joiner", until, message: `As a new joiner you can declare until ${fmt(until)}.` };
  }
  const cutoff = s.declarationCutoff ? mdInFy(fyStart, s.declarationCutoff) : null;
  if (cutoff && today > cutoff) return { open: false, reason: "cutoff_passed", message: `Declarations closed on ${fmt(cutoff)}. Ask your payroll team if something needs to change.` };
  if (s.editWindow.mode === "monthly") {
    const day = Number(today.slice(8, 10)), month = `${today.slice(0, 8)}01`;
    const last = Math.min(s.editWindow.toDay, daysInMonth(month));
    if (day < s.editWindow.fromDay || day > last) {
      const next = day < s.editWindow.fromDay ? `${today.slice(0, 8)}${String(s.editWindow.fromDay).padStart(2, "0")}`
        : (() => { const nm = addDays(monthEnd(month), 1); return `${nm.slice(0, 8)}${String(s.editWindow.fromDay).padStart(2, "0")}`; })();
      const opensOn = cutoff && next > cutoff ? undefined : next;
      return { open: false, reason: "monthly_closed", opensOn, message: opensOn ? `Declarations can be changed from the ${ord(s.editWindow.fromDay)} to the ${ord(last)} of each month. Next window opens ${fmt(opensOn)}.` : "Declarations are closed for this year." };
    }
    const until = `${today.slice(0, 8)}${String(last).padStart(2, "0")}`;
    return { open: true, reason: "open", until: cutoff && cutoff < until ? cutoff : until, message: `Open until ${fmt(cutoff && cutoff < until ? cutoff : until)}.` };
  }
  return { open: true, reason: "open", until: cutoff ?? end, message: cutoff ? `Open until ${fmt(cutoff)}.` : `Open until the end of FY ${fyLabel(fyStart)}.` };
}
const ord = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/** Can proofs be uploaded on `today`? */
export function proofWindow(s: TaxSettings, fyStart: string, today: string): WindowState {
  const end = fyEnd(fyStart);
  if (!s.proofWindow) {
    if (today < fyStart) return { open: false, reason: "not_open_yet", opensOn: fyStart, message: `Proofs for FY ${fyLabel(fyStart)} can be sent from ${fmt(fyStart)}.` };
    if (today > end) return { open: false, reason: "closed", message: `FY ${fyLabel(fyStart)} has ended.` };
    return { open: true, reason: "open", until: end, message: `Send proofs any time until ${fmt(end)}.` };
  }
  const opens = mdInFy(fyStart, s.proofWindow.opens), closes = mdInFy(fyStart, s.proofWindow.closes);
  if (today < opens) return { open: false, reason: "not_open_yet", opensOn: opens, message: `Proof submission opens on ${fmt(opens)} and closes on ${fmt(closes)}.` };
  if (today > closes) return { open: false, reason: "closed", message: `Proof submission closed on ${fmt(closes)}.` };
  return { open: true, reason: "open", until: closes, message: `Send proofs by ${fmt(closes)}.` };
}

/** After the proof cut-off, payroll stops trusting declarations that were never proven. */
export function proofsFinal(s: TaxSettings, fyStart: string, asOf: string) {
  const closes = s.proofWindow ? mdInFy(fyStart, s.proofWindow.closes) : fyEnd(fyStart);
  return asOf > closes;
}

// ---------------------------------------------------------------- amounts that count
export type ItemRow = { section: string; item: string; declaredPaise: number; acceptedPaise: number | null; proofStatus: "not_submitted" | "submitted" | "accepted" | "partially_accepted" | "rejected" };

/**
 * What payroll counts for one item: the verified amount once a proof is checked, the declared amount before that.
 * Once proofs are final (the proof window has closed), an item nobody verified counts as nothing.
 */
export function countedPaise(i: ItemRow, final = false) {
  if (i.proofStatus === "accepted" || i.proofStatus === "partially_accepted") return i.acceptedPaise ?? 0;
  if (i.proofStatus === "rejected") return 0;
  return final ? 0 : i.declaredPaise;
}

/** 80D with its two buckets (family, parents), each capped by whether anyone in it is a senior. */
export function capped80D(items: { item: string; paise: number }[], l: DeclarationLimits["section80D"]) {
  const v = (k: string) => items.filter((i) => i.item === k).reduce((s, i) => s + i.paise, 0);
  const familySenior = v("self_family_senior") > 0, parentSenior = v("parents_senior") > 0;
  const checkup = Math.min(v("preventive_checkup"), l.preventiveCheckupPaise);
  const family = Math.min(v("self_family") + v("self_family_senior") + checkup, familySenior ? l.selfFamilySeniorPaise : l.selfFamilyPaise);
  const parents = Math.min(v("parents") + v("parents_senior"), parentSenior ? l.parentsSeniorPaise : l.parentsPaise);
  return { familyPaise: family, parentsPaise: parents, totalPaise: family + parents };
}

export type SectionTotals = { section80CPaise: number; section80DPaise: number; section80CCD1BPaise: number; section80EPaise: number; homeLoanInterestPaise: number; rentPaise: number };

/** Sum per section from counted amounts. 80C and 24(b) are left uncapped here: the income-tax rates apply those caps. */
export function sectionTotals(items: ItemRow[], limits: DeclarationLimits, final = false): SectionTotals {
  const c = items.map((i) => ({ ...i, paise: countedPaise(i, final) }));
  const sum = (s: string) => c.filter((i) => i.section === s).reduce((a, i) => a + i.paise, 0);
  return {
    section80CPaise: sum("80C"),
    section80DPaise: capped80D(c.filter((i) => i.section === "80D"), limits.section80D).totalPaise,
    section80CCD1BPaise: Math.min(sum("80CCD1B"), limits.section80CCD1BPaise),
    section80EPaise: sum("80E"),
    homeLoanInterestPaise: sum("24B"),
    rentPaise: sum("HRA"),
  };
}

// ---------------------------------------------------------------- HRA (section 10(13A), rule 2A)
export type RentPeriod = { id: string; fromMonth: string; toMonth: string; monthlyRentPaise: number; landlordName: string; landlordPan: string | null; landlordAddress: string; city: string; metro: boolean };
export const METRO_CITIES = ["Mumbai", "Delhi", "Kolkata", "Chennai"];

export function rentByMonth(periods: RentPeriod[], fyStart: string) {
  const months = fyMonths(fyStart);
  return months.map((m) => {
    const p = periods.find((x) => x.fromMonth <= m && x.toMonth >= m);
    return { month: m, rentPaise: p?.monthlyRentPaise ?? 0, metro: p?.metro ?? false };
  });
}
export const annualRent = (periods: RentPeriod[], fyStart: string) => rentByMonth(periods, fyStart).reduce((s, m) => s + m.rentPaise, 0);

/** Overlaps, months outside the year, and the landlord PAN rule. Returns plain-English problems. */
export function checkRentPeriods(periods: RentPeriod[], fyStart: string, l: DeclarationLimits): string[] {
  const out: string[] = [];
  const months = fyMonths(fyStart);
  for (const p of periods) {
    if (p.fromMonth > p.toMonth) out.push("A rent period ends before it starts.");
    if (p.fromMonth < months[0] || p.toMonth > months[11]) out.push(`Rent periods must be inside FY ${fyLabel(fyStart)} (April to March).`);
    if (!p.landlordName.trim()) out.push("Enter the landlord's name.");
  }
  const sorted = [...periods].sort((a, b) => a.fromMonth.localeCompare(b.fromMonth));
  for (let i = 1; i < sorted.length; i++) if (sorted[i].fromMonth <= sorted[i - 1].toMonth) { out.push("Two rent periods cover the same month."); break; }
  if (annualRent(periods, fyStart) > l.hra.landlordPanAboveAnnualPaise) {
    for (const p of periods) if (!p.landlordPan || !isPan(p.landlordPan)) { out.push(`Rent is over ${inr(l.hra.landlordPanAboveAnnualPaise)} a year, so each landlord's PAN is needed (10 characters, like ABCDE1234F).`); break; }
  }
  return [...new Set(out)];
}

export type HraMonth = { month: string; hraPaise: number; basicPaise: number; rentPaise: number; metro: boolean };
/**
 * Exempt HRA: for each month, the least of (a) HRA received, (b) rent paid minus 10% of salary, (c) 50% of salary in a
 * metro or 40% elsewhere — "salary" being basic (+ DA). Worked exactly, summed, and rounded once to the rupee.
 */
export function hraExemption(months: HraMonth[], l: DeclarationLimits) {
  let total = BigInt(0);
  const byMonth = months.map((m) => {
    if (m.rentPaise <= 0 || m.hraPaise <= 0) return { month: m.month, exemptBp: BigInt(0), rule: "none" as const };
    const a = BigInt(m.hraPaise) * BigInt(10_000);
    const b = BigInt(m.rentPaise) * BigInt(10_000) - BigInt(m.basicPaise) * BigInt(l.hra.rentOverSalaryBp);
    const c = BigInt(m.basicPaise) * BigInt(m.metro ? l.hra.metroBp : l.hra.nonMetroBp);
    let v = a, rule: "hra_received" | "rent_over_salary" | "salary_share" = "hra_received";
    if (b < v) { v = b; rule = "rent_over_salary"; }
    if (c < v) { v = c; rule = "salary_share"; }
    if (v < BigInt(0)) v = BigInt(0);
    total += v;
    return { month: m.month, exemptBp: v, rule };
  });
  const exemptPaise = Number((total * BigInt(2) + BigInt(10_000 * 100)) / (BigInt(2) * BigInt(10_000 * 100))) * 100;
  return { exemptPaise, byMonth: byMonth.map((m) => ({ month: m.month, rule: m.rule, exemptPaise: Number(m.exemptBp / BigInt(10_000)) })) };
}

// ---------------------------------------------------------------- the year's salary
export type SalaryComponent = { code: string; kind: string; taxable: boolean };
export type SalaryMonth = { month: string; breakup: Record<string, number> | null; /** share of the month employed: days / days in month */ days: number; ofDays: number };

/** Salary over the year from monthly breakups, pro-rated for joining and leaving mid-month (paise, half-up per line). */
export function projectSalary(months: SalaryMonth[], comps: SalaryComponent[], basicCodes = ["BASIC", "DA"]) {
  const kind = new Map(comps.map((c) => [c.code, c]));
  const out = months.map((m) => {
    let taxable = 0, hra = 0, basic = 0, pfEmployer = 0;
    for (const [code, monthly] of Object.entries(m.breakup ?? {})) {
      const v = m.days >= m.ofDays ? monthly : Number((BigInt(2) * BigInt(monthly) * BigInt(m.days) + BigInt(m.ofDays)) / (BigInt(2) * BigInt(m.ofDays)));
      const c = kind.get(code);
      if (code === "PF_EMPLOYER") pfEmployer += v;
      if (!c || c.kind !== "earning" || !c.taxable) continue;
      taxable += v;
      if (code === "HRA") hra += v;
      if (basicCodes.includes(code)) basic += v;
    }
    return { month: m.month, taxablePaise: taxable, hraPaise: hra, basicPaise: basic, pfEmployerPaise: pfEmployer };
  });
  return {
    months: out,
    taxablePaise: out.reduce((s, m) => s + m.taxablePaise, 0),
    hraPaise: out.reduce((s, m) => s + m.hraPaise, 0),
    basicPaise: out.reduce((s, m) => s + m.basicPaise, 0),
    pfEmployerPaise: out.reduce((s, m) => s + m.pfEmployerPaise, 0),
  };
}

/** Days employed in `month` given joining and (optional) last day. */
export function daysEmployed(month: string, joiningDate: string, exitDate: string | null) {
  const n = daysInMonth(month), end = monthEnd(month);
  if (joiningDate > end || (exitDate && exitDate < month)) return { days: 0, ofDays: n };
  const from = joiningDate > month ? Number(joiningDate.slice(8, 10)) : 1;
  const to = exitDate && exitDate < end ? Number(exitDate.slice(8, 10)) : n;
  return { days: Math.max(0, to - from + 1), ofDays: n };
}

// ---------------------------------------------------------------- previous employer / other income
export type PreviousEmployer = { employerName: string; tan: string | null; incomePaise: number; tdsPaise: number; pfPaise: number; ptPaise: number };
export type OtherIncome = { savingsInterestPaise: number; depositInterestPaise: number; otherPaise: number; otherDescription: string };
export const EMPTY_PREVIOUS: PreviousEmployer = { employerName: "", tan: null, incomePaise: 0, tdsPaise: 0, pfPaise: 0, ptPaise: 0 };
export const EMPTY_OTHER: OtherIncome = { savingsInterestPaise: 0, depositInterestPaise: 0, otherPaise: 0, otherDescription: "" };
const p = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);
const s = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
export const readPrevious = (raw: unknown): PreviousEmployer => { const r = (raw ?? {}) as Record<string, unknown>; return { employerName: s(r.employerName), tan: typeof r.tan === "string" && r.tan ? r.tan : null, incomePaise: p(r.incomePaise), tdsPaise: p(r.tdsPaise), pfPaise: p(r.pfPaise), ptPaise: p(r.ptPaise) }; };
export const readOther = (raw: unknown): OtherIncome => { const r = (raw ?? {}) as Record<string, unknown>; return { savingsInterestPaise: p(r.savingsInterestPaise), depositInterestPaise: p(r.depositInterestPaise), otherPaise: p(r.otherPaise), otherDescription: s(r.otherDescription, 300) }; };
export const otherIncomeTotal = (o: OtherIncome) => o.savingsInterestPaise + o.depositInterestPaise + o.otherPaise;

export type HomeLoan = { lenderName: string; lenderPan: string | null; lenderAddress: string; propertyAddress: string; selfOccupied: boolean };
export type HouseProperty = { rent: RentPeriod[]; homeLoan: HomeLoan | null };
export function readHouse(raw: unknown): HouseProperty {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rent = Array.isArray(r.rent) ? r.rent.flatMap((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.fromMonth !== "string" || typeof o.toMonth !== "string") return [];
    return [{ id: o.id, fromMonth: o.fromMonth, toMonth: o.toMonth, monthlyRentPaise: p(o.monthlyRentPaise), landlordName: s(o.landlordName), landlordPan: typeof o.landlordPan === "string" && o.landlordPan ? o.landlordPan : null, landlordAddress: s(o.landlordAddress, 300), city: s(o.city, 80), metro: o.metro === true }];
  }) : [];
  const h = r.homeLoan as Record<string, unknown> | null | undefined;
  const homeLoan = h && typeof h === "object" ? { lenderName: s(h.lenderName), lenderPan: typeof h.lenderPan === "string" && h.lenderPan ? h.lenderPan : null, lenderAddress: s(h.lenderAddress, 300), propertyAddress: s(h.propertyAddress, 300), selfOccupied: h.selfOccupied !== false } : null;
  return { rent, homeLoan };
}

// ---------------------------------------------------------------- what payroll's TDS projection gets
/**
 * Turns section totals into the statutory engine's TaxDeductions. 80C/24(b)/PT caps are applied by annualTax() from the
 * income-tax rates; 80D and 80CCD(1B) are already capped here; 80E has no cap. The new regime ignores all of these
 * (the engine's "limited" deductions), so the same object works for both regimes.
 */
export function toTaxDeductions(t: SectionTotals, hraExemptPaise: number, extra: { employeePfPaise?: number; professionalTaxPaise?: number } = {}): TaxDeductions {
  return {
    section80CPaise: t.section80CPaise + (extra.employeePfPaise ?? 0),
    otherChapterVIAPaise: t.section80DPaise + t.section80CCD1BPaise + t.section80EPaise,
    hraExemptPaise,
    homeLoanInterestPaise: t.homeLoanInterestPaise,
    professionalTaxPaise: extra.professionalTaxPaise ?? 0,
  };
}

// ---------------------------------------------------------------- PAN and Form 16 files
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const normalisePan = (v: string) => v.replace(/\s+/g, "").toUpperCase();
export const isPan = (v: string) => PAN_RE.test(normalisePan(v));
export const maskPan = (last4: string | null) => (last4 ? `••••••${last4}` : null);

/** Form 16 files are named by PAN: "ABCDE1234F.pdf", "ABCDE1234F_2025-26_PartA.pdf". Returns the PAN, or null. */
export function panFromFileName(name: string) {
  const base = (name.split(/[\\/]/).pop() ?? "").toUpperCase();
  const m = /^([A-Z]{5}[0-9]{4}[A-Z])(?:[^A-Z0-9]|$)/.exec(base);
  return m ? m[1] : null;
}

export function inr(paise: number) {
  return "₹" + new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: paise % 100 ? 2 : 0 }).format(paise / 100);
}
/** "1,50,000.50" / "150000" → paise. Never through floats. null when it isn't an amount. */
export function parseRupees(v: unknown): number | null {
  if (typeof v === "number") v = String(v);
  if (typeof v !== "string") return null;
  const t = v.replace(/[,\s₹]/g, "");
  if (t === "") return 0;
  const m = /^(\d{1,11})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}
