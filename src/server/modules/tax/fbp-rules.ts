/**
 * Flexible benefit plan (pure, no I/O). A company marks some salary components as FBP (fuel, phone, meal, books …).
 * Each person decides, for the financial year, how much of each one they want to use: declared amounts are capped by
 * the component's annual limit and by what their salary structure actually pays for it. What is declared (and later
 * claimed with bills through reimbursable claims) is exempt from tax in the old regime; the new regime ignores it.
 */
export type FbpComponent = { code: string; name: string; annualMaxPaise: number | null; /** monthly amount in the person's current breakup (0 when the structure doesn't carry it) */ monthlyPaise: number; taxable: boolean };
export type FbpItem = { code: string; name: string; limitPaise: number; declaredPaise: number; countedPaise: number; monthlyPaise: number };

/**
 * The most a person may declare for a component: the lower of the plan's annual limit and a year of the component in
 * their salary. A taxable component their structure doesn't carry can't be declared (there is no pay to exempt); a
 * reimbursable one not on the structure is claimed with bills on top, so the plan's limit applies.
 */
export function fbpLimit(c: Pick<FbpComponent, "annualMaxPaise" | "monthlyPaise" | "taxable">): number {
  const fromSalary = c.monthlyPaise * 12;
  if (fromSalary > 0) return c.annualMaxPaise == null ? fromSalary : Math.min(c.annualMaxPaise, fromSalary);
  return c.taxable ? 0 : c.annualMaxPaise ?? 0;
}

/** Declared amounts checked against the limits: the first problem, or null. */
export function fbpProblem(items: Record<string, number>, comps: FbpComponent[]): { code: string; message: string } | null {
  for (const [code, v] of Object.entries(items)) {
    const c = comps.find((x) => x.code === code);
    if (!c) return { code, message: "That component isn't part of the flexible benefit plan." };
    if (!Number.isSafeInteger(v) || v < 0) return { code, message: `${c.name}: enter an amount of zero or more, in whole paise.` };
    const limit = fbpLimit(c);
    if (v > limit) return { code, message: `${c.name}: at most ${inr(limit)} a year${c.annualMaxPaise != null && c.annualMaxPaise < c.monthlyPaise * 12 ? " (the plan's limit)" : " (what your salary carries for it)"}.` };
  }
  return null;
}

/** Each FBP component with its limit and what the person declared (capped). */
export function fbpItems(items: Record<string, number>, comps: FbpComponent[]): FbpItem[] {
  return comps.map((c) => {
    const limit = fbpLimit(c);
    const declared = Math.max(0, Math.min(limit, Number.isSafeInteger(items[c.code]) ? items[c.code] : 0));
    return { code: c.code, name: c.name, limitPaise: limit, declaredPaise: declared, countedPaise: c.taxable ? declared : 0, monthlyPaise: c.monthlyPaise };
  });
}

/** Total exemption the declaration brings (only taxable components matter: a non-taxable one is already exempt). */
export const fbpExemptPaise = (rows: FbpItem[]) => rows.reduce((t, r) => t + r.countedPaise, 0);

/** "MM-DD" window check inside a financial year: open when no window is set, or today is between opens and closes (inclusive). */
export function fbpWindowOpen(window: { opens: string; closes: string } | null, fyStart: string, today: string): { open: boolean; message: string } {
  if (!window) return { open: true, message: "You can change your flexible benefits any time this year." };
  const y = Number(fyStart.slice(0, 4));
  const inFy = (md: string) => `${Number(md.slice(0, 2)) >= 4 ? y : y + 1}-${md}`;
  const opens = inFy(window.opens), closes = inFy(window.closes);
  const open = today >= opens && today <= closes;
  const d = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return { open, message: open ? `Flexible benefits can be changed until ${d(closes)}.` : today < opens ? `Flexible benefits open on ${d(opens)}.` : `Flexible benefits closed on ${d(closes)} for this year.` };
}

export function inr(paise: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(Math.round(paise / 100));
}
