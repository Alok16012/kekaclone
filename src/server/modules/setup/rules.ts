/**
 * First-run setup wizard: the step list, progress kept in tenants.setup_state, and input checks.
 * Pure (no I/O): shared by the server, the wizard UI and unit tests.
 *
 * setup_state shape:
 *   {}                                   → tenant created before the wizard existed: no wizard, no checklist
 *   { status: "pending" }                → brand-new tenant, wizard never opened (dashboard sends admins to /setup once)
 *   { status: "started", startedAt, steps: { company: { status: "done", at }, ... } }
 *   { status: "done", finishedAt, ... }  → finished; checklist hidden
 */

export const SETUP_STEPS = [
  { key: "company", label: "Company", hint: "Legal name, tax numbers and address" },
  { key: "locations", label: "Locations", hint: "Offices and the state each one is in" },
  { key: "departments", label: "Departments", hint: "The teams people belong to" },
  { key: "designations", label: "Designations", hint: "Job titles" },
  { key: "business_units", label: "Business units", hint: "Divisions or brands, if you have them (optional)" },
  { key: "leave", label: "Leave basics", hint: "Leave year and yearly quotas" },
  { key: "policies", label: "Policies", hint: "Holidays, the default shift and weekly off, pay cycle" },
  { key: "people", label: "Add people", hint: "Add employees one by one or import a spreadsheet" },
  { key: "invite", label: "Invite", hint: "Send everyone a link to set their password" },
] as const;

export type SetupStep = (typeof SETUP_STEPS)[number]["key"];
export type StepStatus = "done" | "skipped";
export type SetupState = {
  status: "none" | "pending" | "started" | "done";
  startedAt?: string;
  finishedAt?: string;
  steps: Partial<Record<SetupStep, { status: StepStatus; at: string }>>;
};

export const STEP_KEYS: SetupStep[] = SETUP_STEPS.map((s) => s.key);
export const isStep = (s: string): s is SetupStep => (STEP_KEYS as string[]).includes(s);

/** Reads whatever is stored (possibly {} or garbage) into a well-formed state. */
export function normalize(raw: unknown): SetupState {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const status = o.status === "pending" || o.status === "started" || o.status === "done" ? o.status : "none";
  const steps: SetupState["steps"] = {};
  const rawSteps = o.steps && typeof o.steps === "object" ? (o.steps as Record<string, unknown>) : {};
  for (const k of STEP_KEYS) {
    const v = rawSteps[k] as { status?: unknown; at?: unknown } | undefined;
    if (v && (v.status === "done" || v.status === "skipped")) steps[k] = { status: v.status, at: typeof v.at === "string" ? v.at : "" };
  }
  return {
    status, steps,
    ...(typeof o.startedAt === "string" ? { startedAt: o.startedAt } : {}),
    ...(typeof o.finishedAt === "string" ? { finishedAt: o.finishedAt } : {}),
  };
}

/** Opening the wizard the first time. Idempotent; never reopens a finished setup. */
export function start(s: SetupState, now: string): SetupState {
  if (s.status === "started" || s.status === "done") return s;
  return { ...s, status: "started", startedAt: now };
}

/** Mark a step done or skipped. A step that was done stays done if it is later skipped by going past it. */
export function markStep(s: SetupState, step: SetupStep, status: StepStatus, now: string): SetupState {
  const prev = s.steps[step];
  const next = prev?.status === "done" && status === "skipped" ? prev : { status, at: now };
  const base = s.status === "pending" || s.status === "none" ? { ...s, status: "started" as const, startedAt: s.startedAt ?? now } : s;
  return { ...base, steps: { ...s.steps, [step]: next } };
}

export function finish(s: SetupState, now: string): SetupState {
  return { ...s, status: "done", finishedAt: s.finishedAt ?? now, startedAt: s.startedAt ?? now };
}

/** First step that's neither done nor skipped; the last step when everything has been visited. */
export function nextStep(s: SetupState): SetupStep {
  return STEP_KEYS.find((k) => !s.steps[k]) ?? STEP_KEYS[STEP_KEYS.length - 1];
}

export function progress(s: SetupState) {
  const done = STEP_KEYS.filter((k) => s.steps[k]?.status === "done").length;
  const visited = STEP_KEYS.filter((k) => s.steps[k]).length;
  return { done, visited, total: STEP_KEYS.length, percent: Math.round((done / STEP_KEYS.length) * 100) };
}

/** The checklist card shows for tenants that have a wizard and haven't finished it. */
export const showChecklist = (s: SetupState) => s.status === "pending" || s.status === "started";
/** Only the very first dashboard visit after signup jumps to the wizard. */
export const shouldAutoOpen = (s: SetupState) => s.status === "pending";

// ---------- input checks ----------

/** Indian states and union territories, with the 2-letter codes used on GST / PT registrations. */
export const STATES: { code: string; name: string }[] = [
  { code: "AN", name: "Andaman and Nicobar Islands" }, { code: "AP", name: "Andhra Pradesh" }, { code: "AR", name: "Arunachal Pradesh" },
  { code: "AS", name: "Assam" }, { code: "BR", name: "Bihar" }, { code: "CH", name: "Chandigarh" }, { code: "CG", name: "Chhattisgarh" },
  { code: "DH", name: "Dadra and Nagar Haveli and Daman and Diu" }, { code: "DL", name: "Delhi" }, { code: "GA", name: "Goa" },
  { code: "GJ", name: "Gujarat" }, { code: "HR", name: "Haryana" }, { code: "HP", name: "Himachal Pradesh" }, { code: "JK", name: "Jammu and Kashmir" },
  { code: "JH", name: "Jharkhand" }, { code: "KA", name: "Karnataka" }, { code: "KL", name: "Kerala" }, { code: "LA", name: "Ladakh" },
  { code: "LD", name: "Lakshadweep" }, { code: "MP", name: "Madhya Pradesh" }, { code: "MH", name: "Maharashtra" }, { code: "MN", name: "Manipur" },
  { code: "ML", name: "Meghalaya" }, { code: "MZ", name: "Mizoram" }, { code: "NL", name: "Nagaland" }, { code: "OD", name: "Odisha" },
  { code: "PY", name: "Puducherry" }, { code: "PB", name: "Punjab" }, { code: "RJ", name: "Rajasthan" }, { code: "SK", name: "Sikkim" },
  { code: "TN", name: "Tamil Nadu" }, { code: "TS", name: "Telangana" }, { code: "TR", name: "Tripura" }, { code: "UP", name: "Uttar Pradesh" },
  { code: "UK", name: "Uttarakhand" }, { code: "WB", name: "West Bengal" },
];
export const isStateCode = (c: string) => STATES.some((s) => s.code === c);
export const stateName = (c: string | null | undefined) => STATES.find((s) => s.code === c)?.name ?? c ?? "";

export type CompanyInput = { name: string; pan?: string; tan?: string; line1?: string; line2?: string; city?: string; state?: string; pincode?: string };
export type CompanyClean = { name: string; pan: string | null; tan: string | null; address: { line1?: string; line2?: string; city?: string; state?: string; pincode?: string } };
export type Problem = { field: string; message: string };

const trimTo = (v: string | undefined, n: number) => (v ?? "").trim().slice(0, n);

/** Checks the company step. Returns the cleaned value or the first problem (with the field to highlight). */
export function checkCompany(i: CompanyInput): { ok: true; value: CompanyClean } | { ok: false; problem: Problem } {
  const name = (i.name ?? "").trim().replace(/\s+/g, " ");
  if (name.length < 2) return { ok: false, problem: { field: "name", message: "Enter the registered company name." } };
  if (name.length > 160) return { ok: false, problem: { field: "name", message: "Keep the name under 160 characters." } };
  const pan = (i.pan ?? "").trim().toUpperCase().replace(/\s/g, "");
  if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) return { ok: false, problem: { field: "pan", message: "A PAN looks like ABCDE1234F (5 letters, 4 digits, 1 letter)." } };
  const tan = (i.tan ?? "").trim().toUpperCase().replace(/\s/g, "");
  if (tan && !/^[A-Z]{4}[0-9]{5}[A-Z]$/.test(tan)) return { ok: false, problem: { field: "tan", message: "A TAN looks like ABCD12345E (4 letters, 5 digits, 1 letter)." } };
  const state = (i.state ?? "").trim().toUpperCase();
  if (state && !isStateCode(state)) return { ok: false, problem: { field: "state", message: "Pick a state from the list." } };
  const pincode = (i.pincode ?? "").trim();
  if (pincode && !/^[1-9][0-9]{5}$/.test(pincode)) return { ok: false, problem: { field: "pincode", message: "A PIN code has 6 digits and doesn't start with 0." } };
  const address = Object.fromEntries(Object.entries({ line1: trimTo(i.line1, 200), line2: trimTo(i.line2, 200), city: trimTo(i.city, 80), state, pincode }).filter(([, v]) => v));
  return { ok: true, value: { name, pan: pan || null, tan: tan || null, address } };
}

export const QUOTA_TYPES = [
  { code: "CL", name: "Casual leave" },
  { code: "SL", name: "Sick leave" },
  { code: "EL", name: "Earned leave" },
] as const;
export type QuotaCode = (typeof QUOTA_TYPES)[number]["code"];

// ---------- policies step ----------
export const WEEKLY_OFF_PRESETS = [
  { key: "sat_sun", label: "Saturday and Sunday", pattern: { sat: "off", sun: "off" } },
  { key: "sun", label: "Sunday only", pattern: { sun: "off" } },
  { key: "alt_sat", label: "2nd and 4th Saturday, every Sunday", pattern: { sat: ["work", "off", "work", "off", "work"], sun: "off" } },
] as const;
export type WeeklyOffPreset = (typeof WEEKLY_OFF_PRESETS)[number]["key"];
export type PoliciesInput = { shiftStart: unknown; shiftEnd: unknown; weeklyOff: unknown; cutoffDay?: unknown };
export type PoliciesClean = { shiftStart: string; shiftEnd: string; weeklyOff: WeeklyOffPreset; cutoffDay: number | null };

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Shift times are HH:MM and the day must last at least 4 hours; the weekly off is one of the presets; the cut-off day is 1–31. */
export function checkPolicies(i: PoliciesInput): { ok: true; value: PoliciesClean } | { ok: false; problem: Problem } {
  const start = typeof i.shiftStart === "string" ? i.shiftStart.trim() : "", end = typeof i.shiftEnd === "string" ? i.shiftEnd.trim() : "";
  if (!HHMM.test(start)) return { ok: false, problem: { field: "shiftStart", message: "Enter the shift start as HH:MM, e.g. 09:30." } };
  if (!HHMM.test(end)) return { ok: false, problem: { field: "shiftEnd", message: "Enter the shift end as HH:MM, e.g. 18:30." } };
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const len = (toMin(end) - toMin(start) + 1440) % 1440;
  if (len < 240) return { ok: false, problem: { field: "shiftEnd", message: "The shift must be at least 4 hours long." } };
  if (!WEEKLY_OFF_PRESETS.some((p) => p.key === i.weeklyOff)) return { ok: false, problem: { field: "weeklyOff", message: "Pick a weekly-off pattern." } };
  let cutoffDay: number | null = null;
  if (i.cutoffDay !== undefined && i.cutoffDay !== null && i.cutoffDay !== "") {
    const n = typeof i.cutoffDay === "number" ? i.cutoffDay : Number(i.cutoffDay);
    if (!Number.isInteger(n) || n < 1 || n > 31) return { ok: false, problem: { field: "cutoffDay", message: "The attendance cut-off is a day of the month, 1 to 31." } };
    cutoffDay = n;
  }
  return { ok: true, value: { shiftStart: start, shiftEnd: end, weeklyOff: i.weeklyOff as WeeklyOffPreset, cutoffDay } };
}
export type LeaveBasics = { yearStart: "jan" | "apr"; quotas: Record<QuotaCode, number> };

/** Quotas are whole or half days between 0 and 60 a year. */
export function checkLeaveBasics(i: { yearStart: unknown; quotas: Record<string, unknown> }): { ok: true; value: LeaveBasics } | { ok: false; problem: Problem } {
  if (i.yearStart !== "jan" && i.yearStart !== "apr") return { ok: false, problem: { field: "yearStart", message: "Choose when your leave year starts." } };
  const quotas = {} as Record<QuotaCode, number>;
  for (const t of QUOTA_TYPES) {
    const raw = i.quotas?.[t.code];
    const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    if (!Number.isFinite(n) || n < 0 || n > 60) return { ok: false, problem: { field: t.code, message: `${t.name}: enter a number of days from 0 to 60.` } };
    if (Math.round(n * 2) !== n * 2) return { ok: false, problem: { field: t.code, message: `${t.name}: use whole or half days.` } };
    quotas[t.code] = n;
  }
  return { ok: true, value: { yearStart: i.yearStart, quotas } };
}
