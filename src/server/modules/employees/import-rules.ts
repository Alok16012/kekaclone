/**
 * Bulk import: column layout + row validation. Pure (no I/O) so every rule is unit-tested.
 * The service reads the workbook, loads lookups, calls validateImport, and writes only when every row is valid.
 */
export const IMPORT_COLUMNS = [
  { key: "firstName", header: "First name", required: true, width: 16, example: "Neha" },
  { key: "lastName", header: "Last name", required: false, width: 16, example: "Gupta" },
  { key: "workEmail", header: "Work email", required: true, width: 28, example: "neha.gupta@yourcompany.com" },
  { key: "mobile", header: "Mobile", required: false, width: 16, example: "+91 98xxxxxx01" },
  { key: "employeeNumber", header: "Employee number", required: false, width: 16, example: "" },
  { key: "joiningDate", header: "Joining date", required: true, width: 14, example: "2026-11-02" },
  { key: "gender", header: "Gender", required: false, width: 14, example: "Female" },
  { key: "department", header: "Department", required: false, width: 18, example: "" },
  { key: "designation", header: "Designation", required: false, width: 22, example: "" },
  { key: "location", header: "Location", required: false, width: 16, example: "" },
  { key: "managerEmail", header: "Manager's work email", required: false, width: 28, example: "" },
] as const;

export type ImportKey = (typeof IMPORT_COLUMNS)[number]["key"];
export type RawRow = { rowNumber: number; values: Partial<Record<ImportKey, unknown>> };
export const MAX_ROWS = 1000;

export type Lookups = {
  departments: Map<string, string>;   // lower(name) → id
  designations: Map<string, string>;
  locations: Map<string, string>;
  employeesByEmail: Map<string, string>; // existing people: lower(email) → id
  employeeNumbers: Set<string>;          // existing numbers (lower)
};

export type ValidRow = {
  rowNumber: number;
  firstName: string; lastName: string | null; workEmail: string; mobile: string | null; employeeNumber: string | null;
  joiningDate: string; gender: "male" | "female" | "non_binary" | "undisclosed" | null;
  departmentId: string | null; designationId: string | null; locationId: string | null;
  manager: { kind: "existing"; id: string } | { kind: "row"; email: string } | null;
};
export type RowResult = { rowNumber: number; name: string; email: string; errors: string[]; row?: ValidRow };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GENDERS: Record<string, ValidRow["gender"]> = { male: "male", m: "male", female: "female", f: "female", "non-binary": "non_binary", "non binary": "non_binary", nonbinary: "non_binary", "prefer not to say": "undisclosed", undisclosed: "undisclosed" };

export function cellText(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as { text?: unknown; result?: unknown; richText?: { text: string }[]; hyperlink?: string };
    if (o.richText) return o.richText.map((r) => r.text).join("").trim();
    if (o.text != null) return cellText(o.text);
    if (o.result != null) return cellText(o.result);
    if (o.hyperlink) return o.hyperlink.replace(/^mailto:/, "").trim();
  }
  return String(v).trim();
}

/** Accepts a real date cell, YYYY-MM-DD, DD-MM-YYYY or DD/MM/YYYY (Indian order; never MM/DD). */
export function parseDate(v: unknown): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const s = cellText(v);
  let y: number, m: number, d: number;
  let mt = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (mt) [y, m, d] = [+mt[1], +mt[2], +mt[3]];
  else if ((mt = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) [d, m, y] = [+mt[1], +mt[2], +mt[3]];
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || y < 1950 || y > 2100) return null;
  return dt.toISOString().slice(0, 10);
}

export function validateImport(raw: RawRow[], lk: Lookups): { results: RowResult[]; valid: boolean; order: ValidRow[] } {
  const rows = raw.filter((r) => Object.values(r.values).some((v) => cellText(v) !== ""));   // skip blank lines
  const results: RowResult[] = [];
  const fileEmails = new Map<string, number>(), fileNumbers = new Map<string, number>();
  for (const r of rows) {
    const e = cellText(r.values.workEmail).toLowerCase(), n = cellText(r.values.employeeNumber).toLowerCase();
    if (e) fileEmails.set(e, (fileEmails.get(e) ?? 0) + 1);
    if (n) fileNumbers.set(n, (fileNumbers.get(n) ?? 0) + 1);
  }

  for (const r of rows) {
    const t = (k: ImportKey) => cellText(r.values[k]);
    const errors: string[] = [];
    const firstName = t("firstName"), email = t("workEmail").toLowerCase(), number = t("employeeNumber");
    if (!firstName) errors.push("First name is missing.");
    if (firstName.length > 60) errors.push("First name is longer than 60 characters.");
    if (!email) errors.push("Work email is missing.");
    else if (!EMAIL.test(email)) errors.push(`“${t("workEmail")}” isn't a valid email.`);
    else if (lk.employeesByEmail.has(email)) errors.push("Someone in your company already uses this work email.");
    else if ((fileEmails.get(email) ?? 0) > 1) errors.push("This work email appears more than once in the file.");
    if (number) {
      if (lk.employeeNumbers.has(number.toLowerCase())) errors.push(`Employee number ${number} is already taken.`);
      else if ((fileNumbers.get(number.toLowerCase()) ?? 0) > 1) errors.push(`Employee number ${number} appears more than once in the file.`);
    }
    const joiningDate = parseDate(r.values.joiningDate);
    if (!t("joiningDate")) errors.push("Joining date is missing.");
    else if (!joiningDate) errors.push(`Joining date “${t("joiningDate")}” isn't a date. Use YYYY-MM-DD or DD-MM-YYYY.`);
    const g = t("gender").toLowerCase();
    const gender = g ? GENDERS[g] ?? null : null;
    if (g && !gender) errors.push(`Gender “${t("gender")}” isn't recognised. Use Female, Male, Non-binary or Prefer not to say.`);
    const pick = (k: "department" | "designation" | "location", map: Map<string, string>, label: string) => {
      const v = t(k);
      if (!v) return null;
      const id = map.get(v.toLowerCase());
      if (!id) errors.push(`${label} “${v}” doesn't exist. Add it in Settings or fix the spelling.`);
      return id ?? null;
    };
    const departmentId = pick("department", lk.departments, "Department");
    const designationId = pick("designation", lk.designations, "Designation");
    const locationId = pick("location", lk.locations, "Location");
    let manager: ValidRow["manager"] = null;
    const me = t("managerEmail").toLowerCase();
    if (me) {
      if (me === email) errors.push("Someone can't be their own manager.");
      else if (lk.employeesByEmail.has(me)) manager = { kind: "existing", id: lk.employeesByEmail.get(me)! };
      else if (fileEmails.has(me)) manager = { kind: "row", email: me };
      else errors.push(`Manager “${t("managerEmail")}” isn't in your company or in this file.`);
    }
    results.push({
      rowNumber: r.rowNumber, name: [firstName, t("lastName")].filter(Boolean).join(" ") || "(no name)", email, errors,
      row: errors.length ? undefined : {
        rowNumber: r.rowNumber, firstName, lastName: t("lastName") || null, workEmail: email, mobile: t("mobile") || null, employeeNumber: number || null,
        joiningDate: joiningDate!, gender, departmentId, designationId, locationId, manager,
      },
    });
  }

  if (rows.length === 0) return { results, valid: false, order: [] };
  if (rows.length > MAX_ROWS) results[0].errors.push(`The file has ${rows.length} rows; import up to ${MAX_ROWS} at a time.`);

  // managers inside the file must be created first; a cycle (A→B→A) can't be ordered
  const byEmail = new Map(results.filter((r) => r.row).map((r) => [r.email, r]));
  const order: ValidRow[] = [], state = new Map<string, "visiting" | "done">();
  const visit = (res: RowResult, path: string[]): boolean => {
    const s = state.get(res.email);
    if (s === "done") return true;
    if (s === "visiting") { res.errors.push(`Reporting loop in the file: ${[...path, res.email].join(" → ")}.`); return false; }
    state.set(res.email, "visiting");
    const m = res.row!.manager;
    if (m?.kind === "row") {
      const target = byEmail.get(m.email);
      if (!target) { res.errors.push("This person's manager has errors in the file, so they can't be linked yet."); state.set(res.email, "done"); return false; }
      if (!visit(target, [...path, res.email])) { state.set(res.email, "done"); return false; }
    }
    state.set(res.email, "done");
    order.push(res.row!);
    return true;
  };
  for (const r of results) if (r.row) visit(r, []);
  for (const r of results) if (r.errors.length) r.row = undefined;
  const valid = results.every((r) => r.errors.length === 0);
  return { results, valid, order: valid ? order : [] };
}
