/**
 * Payroll foundation rules (pure, no I/O): salary structure evaluation, revision dating, and field validation.
 * Imported by the server and by client components (live structure preview), so nothing here touches the DB or env.
 *
 * Money is integer paise everywhere. Rounding (the only places it happens):
 *   1. Monthly CTC = annual CTC ÷ 12, rounded half-up to the paisa.
 *   2. Every line except the balancing one is rounded half-up to a whole rupee.
 *      Formulas that reference another line ([BASIC]) see that line's rounded monthly amount.
 *   3. The balancing line = monthly CTC − every other line, so the monthly lines always add up to monthly CTC exactly
 *      (the balancing line may therefore carry paise). Annual figures shown are monthly × 12.
 * Inside a formula, arithmetic is exact (fractions), so evaluation order never changes the result.
 */
import { cmp, div, evaluate, mul, parseDecimal, parseFormula, rat, roundHalfUp, FormulaError, type Node, type Rat } from "./formula";

export const COMPONENT_KINDS = ["earning", "reimbursable", "deduction", "reimbursement", "adhoc_earning", "adhoc_deduction", "bonus", "employer_contribution"] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];
/** Kinds that make up CTC and so may sit on a salary structure. Deductions and one-offs are handled when payroll runs. */
export const STRUCTURE_KINDS: readonly ComponentKind[] = ["earning", "reimbursable", "employer_contribution"];
export const FREQUENCIES = ["monthly", "quarterly", "half_yearly", "yearly", "one_time"] as const;
export const CALCS = ["flat", "pct_ctc", "pct_gross", "formula", "balancing"] as const;
export type Calc = (typeof CALCS)[number];
export const PAYABLE_BASES = ["calendar", "fixed_30", "working"] as const;
/** Names formulas can use besides component codes. */
export const RESERVED_CODES = ["CTC", "GROSS"] as const;

export type StructureLine = { code: string; name?: string; kind: ComponentKind; calc: Calc; value?: string | number | null; formula?: string | null };
export type StructureDef = { lines: StructureLine[] };
export type Issue = { code?: string; message: string };
export type BreakupLine = { code: string; name: string; kind: ComponentKind; calc: Calc; monthlyPaise: number; annualPaise: number };
export type Breakup =
  | { ok: true; annualCtcPaise: number; monthlyCtcPaise: number; grossMonthlyPaise: number; lines: BreakupLine[]; breakup: Record<string, number> }
  | { ok: false; errors: Issue[] };

/** Largest annual CTC accepted: ₹100 crore (keeps every paise amount well inside a safe integer). */
export const MAX_CTC_PAISE = 100_00_00_000_00;

const toRat = (v: string | number | null | undefined): Rat | null => (v == null || v === "" ? null : parseDecimal(String(v)));
const paiseToRupees = (p: number | bigint) => rat(BigInt(p), BigInt(100));

type Prepared = { line: StructureLine; deps: string[]; ast?: Node; value?: Rat };

/**
 * Static checks on a structure: codes, calc/value pairs, formulas parse, references exist, exactly one balancing
 * earning, and no circular references (GROSS = CTC − employer contributions; the balancing line depends on all others).
 * Returns the evaluation order when valid.
 */
export function analyseStructure(s: StructureDef): { issues: Issue[]; order: string[]; prepared: Map<string, Prepared> } {
  const issues: Issue[] = [];
  const prepared = new Map<string, Prepared>();
  const codes = new Set<string>();
  for (const l of s.lines) {
    if (codes.has(l.code)) issues.push({ code: l.code, message: `[${l.code}] appears twice. Each component can be on a structure once.` });
    codes.add(l.code);
  }
  if (!s.lines.length) issues.push({ message: "Add at least one component." });
  const balancing = s.lines.filter((l) => l.calc === "balancing");
  if (balancing.length === 0 && s.lines.length) issues.push({ message: "Pick one line as the balancing line, so the components add up to CTC." });
  if (balancing.length > 1) issues.push({ message: "Only one line can be the balancing line." });

  for (const l of s.lines) {
    const label = l.name ? `${l.name} [${l.code}]` : `[${l.code}]`;
    if (!STRUCTURE_KINDS.includes(l.kind)) { issues.push({ code: l.code, message: `${label} is a ${l.kind.replace(/_/g, " ")} component. Only earnings, reimbursables and employer contributions are part of CTC.` }); continue; }
    const p: Prepared = { line: l, deps: [] };
    if (l.calc === "balancing") {
      if (l.kind !== "earning") issues.push({ code: l.code, message: `The balancing line must be an earning; ${label} isn't.` });
      p.deps = s.lines.filter((x) => x !== l).map((x) => x.code);
    } else if (l.calc === "formula") {
      const r = parseFormula(l.formula ?? "");
      if (!r.ok) { issues.push({ code: l.code, message: `${label}: ${r.error}` }); continue; }
      const unknown = r.refs.filter((c) => !codes.has(c) && !(RESERVED_CODES as readonly string[]).includes(c));
      if (unknown.length) { issues.push({ code: l.code, message: `${label} uses ${unknown.map((c) => `[${c}]`).join(", ")}, which ${unknown.length > 1 ? "aren't" : "isn't"} on this structure.` }); continue; }
      p.ast = r.ast; p.deps = r.refs;
    } else {
      const v = toRat(l.value);
      if (!v) { issues.push({ code: l.code, message: `${label}: enter ${l.calc === "flat" ? "a monthly amount" : "a percentage"}.` }); continue; }
      if (v.n < BigInt(0)) { issues.push({ code: l.code, message: `${label} can't be negative.` }); continue; }
      if (l.calc !== "flat" && cmp(v, rat(BigInt(100))) > 0) { issues.push({ code: l.code, message: `${label}: a percentage can't be more than 100.` }); continue; }
      p.value = v; p.deps = l.calc === "pct_ctc" ? ["CTC"] : l.calc === "pct_gross" ? ["GROSS"] : [];
    }
    prepared.set(l.code, p);
  }
  if (issues.length) return { issues, order: [], prepared };

  // dependency graph incl. the virtual GROSS node; CTC is an input
  const deps = new Map<string, string[]>([...prepared].map(([c, p]) => [c, p.deps.filter((d) => d !== "CTC")]));
  deps.set("GROSS", s.lines.filter((l) => l.kind === "employer_contribution").map((l) => l.code));
  const order: string[] = [];
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (c: string): string[] | null => {
    if (state.get(c) === 2) return null;
    if (state.get(c) === 1) return [...stack.slice(stack.indexOf(c)), c];
    state.set(c, 1); stack.push(c);
    for (const d of deps.get(c) ?? []) { const cyc = visit(d); if (cyc) return cyc; }
    stack.pop(); state.set(c, 2); order.push(c);
    return null;
  };
  for (const c of [...deps.keys()]) {
    const cyc = visit(c);
    if (cyc) {
      const shown = cyc.map((x) => `[${x}]`).join(" → ");
      issues.push({ code: cyc[0] === "GROSS" ? cyc[1] : cyc[0], message: `Circular reference: ${shown}. ${cyc.includes("GROSS") ? "Gross is CTC minus employer contributions, so an employer contribution can't depend on gross. " : ""}Change one of these lines so it doesn't depend on the other.` });
      return { issues, order: [], prepared };
    }
  }
  return { issues, order: order.filter((c) => c !== "GROSS"), prepared };
}

/** Monthly breakup of an annual CTC on a structure. Deterministic integer paise; see the rounding notes at the top. */
export function computeBreakup(s: StructureDef, annualCtcPaise: number | bigint): Breakup {
  const annual = Number(annualCtcPaise);
  if (!Number.isSafeInteger(annual) || annual <= 0) return { ok: false, errors: [{ message: "CTC must be more than zero." }] };
  if (annual > MAX_CTC_PAISE) return { ok: false, errors: [{ message: "That CTC is larger than erp supports (₹100 crore)." }] };
  const { issues, order, prepared } = analyseStructure(s);
  if (issues.length) return { ok: false, errors: issues };

  const monthlyCtc = roundHalfUp(rat(BigInt(annual), BigInt(12)));   // paise
  const amounts = new Map<string, bigint>();                   // paise
  const errors: Issue[] = [];
  let gross: bigint | null = null;
  const grossPaise = (): bigint => {
    if (gross == null) gross = monthlyCtc - s.lines.filter((l) => l.kind === "employer_contribution").reduce((t, l) => t + amounts.get(l.code)!, BigInt(0));
    return gross;
  };
  const get = (code: string): Rat => code === "CTC" ? paiseToRupees(monthlyCtc) : code === "GROSS" ? paiseToRupees(grossPaise()) : paiseToRupees(amounts.get(code)!);
  const wholeRupees = (r: Rat) => roundHalfUp(r) * BigInt(100);

  for (const code of order) {
    const p = prepared.get(code)!;
    const l = p.line;
    let paise: bigint;
    try {
      if (l.calc === "balancing") paise = monthlyCtc - s.lines.filter((x) => x !== l).reduce((t, x) => t + amounts.get(x.code)!, BigInt(0));
      else if (l.calc === "flat") paise = wholeRupees(p.value!);
      else if (l.calc === "pct_ctc") paise = wholeRupees(div(mul(get("CTC"), p.value!), rat(BigInt(100))));
      else if (l.calc === "pct_gross") paise = wholeRupees(div(mul(get("GROSS"), p.value!), rat(BigInt(100))));
      else paise = wholeRupees(evaluate(p.ast!, get));
    } catch (e) {
      if (e instanceof FormulaError) { errors.push({ code, message: `${l.name ?? `[${code}]`}: ${e.message}` }); amounts.set(code, BigInt(0)); continue; }
      throw e;
    }
    if (paise < BigInt(0)) {
      errors.push({ code, message: l.calc === "balancing"
        ? `This CTC is too low for the structure: the other lines already add up to more than the monthly CTC, so ${l.name ?? `[${code}]`} would be negative.`
        : `${l.name ?? `[${code}]`} works out negative for this CTC.` });
    }
    amounts.set(code, paise);
  }
  if (errors.length) return { ok: false, errors };
  const lines = s.lines.map((l): BreakupLine => {
    const m = Number(amounts.get(l.code)!);
    return { code: l.code, name: l.name ?? l.code, kind: l.kind, calc: l.calc, monthlyPaise: m, annualPaise: m * 12 };
  });
  return {
    ok: true, annualCtcPaise: annual, monthlyCtcPaise: Number(monthlyCtc), grossMonthlyPaise: Number(grossPaise()), lines,
    breakup: Object.fromEntries(lines.map((l) => [l.code, l.monthlyPaise])),
  };
}

// ---------------------------------------------------------------- revisions

/** First day of the month an ISO date falls in. */
export const monthOf = (iso: string) => `${iso.slice(0, 7)}-01`;

/**
 * Which month arrears start from for a salary effective on `effectiveFrom`, or null when no arrears are due.
 * Arrears are due when the revision reaches back into a month payroll has already been run for: any month before the
 * current one, or the current/later month if its run is already finalised (`lockedMonths`, first-of-month dates).
 */
export function arrearsFromMonth(effectiveFrom: string, today: string, lockedMonths: string[] = []): string | null {
  const m = monthOf(effectiveFrom);
  if (m < monthOf(today)) return m;
  return lockedMonths.some((x) => x >= m) ? m : null;
}

export const REVISION_REASONS = ["revision", "promotion", "correction"] as const;

// ---------------------------------------------------------------- field validation

export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const normaliseIfsc = (s: string) => s.replace(/\s+/g, "").toUpperCase();
export const isIfsc = (s: string) => IFSC_RE.test(normaliseIfsc(s));
/** Indian bank account numbers are 9 to 18 digits. */
export const normaliseAccount = (s: string) => s.replace(/[\s-]/g, "");
export const isAccountNumber = (s: string) => /^\d{9,18}$/.test(normaliseAccount(s));
export const isUan = (s: string) => /^\d{12}$/.test(s);
export const isEsiNumber = (s: string) => /^\d{10}$/.test(s);
export const isPfNumber = (s: string) => /^[A-Z]{2}[A-Z0-9/]{5,24}$/.test(s);
export const last4 = (account: string) => normaliseAccount(account).slice(-4);

/** States and union territories (ISO 3166-2:IN subdivision codes), for professional tax and LWF. */
export const INDIAN_STATES: { code: string; name: string }[] = [
  ["AN", "Andaman and Nicobar Islands"], ["AP", "Andhra Pradesh"], ["AR", "Arunachal Pradesh"], ["AS", "Assam"], ["BR", "Bihar"],
  ["CH", "Chandigarh"], ["CT", "Chhattisgarh"], ["DH", "Dadra and Nagar Haveli and Daman and Diu"], ["DL", "Delhi"], ["GA", "Goa"],
  ["GJ", "Gujarat"], ["HP", "Himachal Pradesh"], ["HR", "Haryana"], ["JH", "Jharkhand"], ["JK", "Jammu and Kashmir"], ["KA", "Karnataka"],
  ["KL", "Kerala"], ["LA", "Ladakh"], ["LD", "Lakshadweep"], ["MH", "Maharashtra"], ["ML", "Meghalaya"], ["MN", "Manipur"],
  ["MP", "Madhya Pradesh"], ["MZ", "Mizoram"], ["NL", "Nagaland"], ["OR", "Odisha"], ["PB", "Punjab"], ["PY", "Puducherry"],
  ["RJ", "Rajasthan"], ["SK", "Sikkim"], ["TG", "Telangana"], ["TN", "Tamil Nadu"], ["TR", "Tripura"], ["UP", "Uttar Pradesh"],
  ["UT", "Uttarakhand"], ["WB", "West Bengal"],
].map(([code, name]) => ({ code, name }));
export const isStateCode = (s: string) => INDIAN_STATES.some((x) => x.code === s);

// ---------------------------------------------------------------- spreadsheet cells

/** A rupee amount from a spreadsheet cell (number or text like "12,00,000" / "₹ 1200000.50") → paise. Null if not a valid amount. */
export function cellToPaise(v: unknown): number | null {
  if (v == null || v === "") return null;
  let s = typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : String(v);
  if (/e/i.test(s)) return null;
  s = s.replace(/[₹,\s]/g, "").replace(/^rs\.?/i, "");
  const r = parseDecimal(s);
  if (!r || r.n < BigInt(0)) return null;
  const paise = mul(r, rat(BigInt(100)));
  if (paise.d !== BigInt(1)) return null;   // more than two decimals
  const n = Number(paise.n);
  return Number.isSafeInteger(n) ? n : null;
}

/** A date from a spreadsheet cell: a real date cell, "YYYY-MM-DD", or "DD/MM/YYYY" / "DD-MM-YYYY". */
export function cellToISODate(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = String(v ?? "").trim();
  let y: number, m: number, d: number;
  let mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (mt) [y, m, d] = [Number(mt[1]), Number(mt[2]), Number(mt[3])];
  else if ((mt = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s))) [d, m, y] = [Number(mt[1]), Number(mt[2]), Number(mt[3])];
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

