/**
 * Excel bulk UPDATE of existing people: column layout and per-row diffing. Pure, so every rule is unit-tested.
 * A blank cell means "leave as it is"; the employee number identifies the person and can't be changed here.
 */
import { cellText, parseDate } from "@/server/modules/employees/import-rules";
import { coerceFieldValue, type CustomFieldDef, type FieldValue } from "./rules";

export const UPDATE_COLUMNS = [
  { key: "employeeNumber", header: "Employee number", width: 16 },
  { key: "name", header: "Name (not changed)", width: 24 },
  { key: "firstName", header: "First name", width: 16 },
  { key: "lastName", header: "Last name", width: 16 },
  { key: "mobile", header: "Mobile", width: 16 },
  { key: "personalEmail", header: "Personal email", width: 26 },
  { key: "dob", header: "Date of birth", width: 14 },
  { key: "gender", header: "Gender", width: 14 },
  { key: "department", header: "Department", width: 18 },
  { key: "designation", header: "Designation", width: 22 },
  { key: "location", header: "Location", width: 16 },
  { key: "managerEmail", header: "Manager's work email", width: 28 },
  { key: "workerType", header: "Worker type", width: 14 },
] as const;
export type UpdateKey = (typeof UPDATE_COLUMNS)[number]["key"];
export const MAX_UPDATE_ROWS = 2000;

export type Current = {
  id: string; employee_number: string; display_name: string; first_name: string; last_name: string | null; mobile: string | null; personal_email: string | null;
  dob: string | null; gender: string | null; department_id: string | null; designation_id: string | null; location_id: string | null; manager_id: string | null;
  worker_type: string; custom: Record<string, FieldValue>; inScope: boolean;
};
export type UpdateLookups = {
  byNumber: Map<string, Current>;          // lower(number) → person
  departments: Map<string, string>; designations: Map<string, string>; locations: Map<string, string>;
  employeesByEmail: Map<string, string>;  // lower(email) → id (current people only)
  customDefs: CustomFieldDef[];           // published, HR-editable
};
export type UpdateRaw = { rowNumber: number; values: Partial<Record<UpdateKey, unknown>>; custom: Record<string, unknown> };
export type FieldChange = { field: string; label: string; from: string | null; to: string | null };
export type UpdateRow = {
  rowNumber: number; employeeId: string | null; name: string; errors: string[]; changes: FieldChange[];
  profile: Record<string, unknown>; job: Record<string, string | null>; custom: Record<string, FieldValue>;
};

const GENDERS: Record<string, string> = { male: "male", m: "male", female: "female", f: "female", "non-binary": "non_binary", "non binary": "non_binary", nonbinary: "non_binary", "prefer not to say": "undisclosed", undisclosed: "undisclosed" };
const WORKERS: Record<string, string> = { permanent: "permanent", contract: "contract", intern: "intern", consultant: "consultant", daily: "daily", "daily wage": "daily", piece: "piece", "piece rate": "piece" };

export function diffUpdateRows(raw: UpdateRaw[], lk: UpdateLookups, names: { departments: Map<string, string>; designations: Map<string, string>; locations: Map<string, string>; people: Map<string, string> }) {
  const rows = raw.filter((r) => Object.values(r.values).some((v) => cellText(v) !== "") || Object.values(r.custom).some((v) => cellText(v) !== ""));
  const seen = new Map<string, number>();
  for (const r of rows) { const n = cellText(r.values.employeeNumber).toLowerCase(); if (n) seen.set(n, (seen.get(n) ?? 0) + 1); }
  const out: UpdateRow[] = [];
  for (const r of rows) {
    const t = (k: UpdateKey) => cellText(r.values[k]);
    const errors: string[] = [], changes: FieldChange[] = [];
    const profile: Record<string, unknown> = {}, job: Record<string, string | null> = {}, custom: Record<string, FieldValue> = {};
    const number = t("employeeNumber");
    const cur = number ? lk.byNumber.get(number.toLowerCase()) : undefined;
    if (!number) errors.push("Employee number is missing.");
    else if (!cur) errors.push(`No one has employee number ${number}.`);
    else if (!cur.inScope) errors.push("You can't update this person (outside the people you manage).");
    else if ((seen.get(number.toLowerCase()) ?? 0) > 1) errors.push(`Employee number ${number} appears more than once in the file.`);
    if (!cur || errors.length) { out.push({ rowNumber: r.rowNumber, employeeId: cur?.id ?? null, name: cur?.display_name ?? (number || "(no number)"), errors, changes, profile, job, custom }); continue; }

    const set = (field: string, label: string, from: string | null, to: string | null, target: "profile" | "job", value: unknown = to) => {
      if ((from ?? null) === (to ?? null)) return;
      changes.push({ field, label, from, to });
      if (target === "profile") profile[field] = value; else job[field] = value as string | null;
    };
    const fn = t("firstName");
    if (fn) { if (fn.length > 60) errors.push("First name is longer than 60 characters."); else set("first_name", "First name", cur.first_name, fn, "profile"); }
    const ln = t("lastName");
    if (ln) { if (ln.length > 60) errors.push("Last name is longer than 60 characters."); else set("last_name", "Last name", cur.last_name, ln, "profile"); }
    const mob = t("mobile");
    if (mob) { if (!/^\+?[0-9 ()-]{6,20}$/.test(mob)) errors.push(`Mobile “${mob}” isn't a phone number.`); else set("mobile", "Mobile", cur.mobile, mob, "profile"); }
    const pe = t("personalEmail").toLowerCase();
    if (pe) { if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pe)) errors.push(`Personal email “${pe}” isn't valid.`); else set("personal_email", "Personal email", cur.personal_email, pe, "profile"); }
    if (t("dob")) {
      const d = parseDate(r.values.dob);
      if (!d) errors.push(`Date of birth “${t("dob")}” isn't a date. Use YYYY-MM-DD or DD-MM-YYYY.`);
      else set("dob", "Date of birth", cur.dob, d, "profile");
    }
    const g = t("gender").toLowerCase();
    if (g) { if (!GENDERS[g]) errors.push(`Gender “${t("gender")}” isn't recognised.`); else set("gender", "Gender", cur.gender, GENDERS[g], "profile"); }
    const pick = (k: "department" | "designation" | "location", map: Map<string, string>, col: "department_id" | "designation_id" | "location_id", label: string, nm: Map<string, string>) => {
      const v = t(k);
      if (!v) return;
      const id = map.get(v.toLowerCase());
      if (!id) { errors.push(`${label} “${v}” doesn't exist. Add it in Settings or fix the spelling.`); return; }
      if (cur[col] !== id) { changes.push({ field: col, label, from: cur[col] ? nm.get(cur[col]!) ?? null : null, to: nm.get(id) ?? v }); job[col] = id; }
    };
    pick("department", lk.departments, "department_id", "Department", names.departments);
    pick("designation", lk.designations, "designation_id", "Designation", names.designations);
    pick("location", lk.locations, "location_id", "Location", names.locations);
    const me = t("managerEmail").toLowerCase();
    if (me) {
      const mid = lk.employeesByEmail.get(me);
      if (!mid) errors.push(`Manager “${me}” isn't a current employee.`);
      else if (mid === cur.id) errors.push("Someone can't be their own manager.");
      else if (cur.manager_id !== mid) { changes.push({ field: "manager_id", label: "Reports to", from: cur.manager_id ? names.people.get(cur.manager_id) ?? null : null, to: names.people.get(mid) ?? me }); job.manager_id = mid; }
    }
    const wt = t("workerType").toLowerCase();
    if (wt) { if (!WORKERS[wt]) errors.push(`Worker type “${t("workerType")}” must be Permanent, Contract, Intern or Consultant.`); else if (cur.worker_type !== WORKERS[wt]) { changes.push({ field: "worker_type", label: "Worker type", from: cur.worker_type, to: WORKERS[wt] }); job.worker_type = WORKERS[wt]; } }
    for (const d of lk.customDefs) {
      const v = r.custom[d.key];
      if (cellText(v) === "") continue;
      const c = coerceFieldValue({ ...d, required: false }, v instanceof Date ? v : cellText(v));
      if (!c.ok) { errors.push(c.error); continue; }
      if (JSON.stringify(cur.custom?.[d.key] ?? null) !== JSON.stringify(c.value)) {
        changes.push({ field: `custom.${d.key}`, label: d.label, from: cur.custom?.[d.key] == null ? null : String(cur.custom[d.key]), to: c.value == null ? null : String(c.value) });
        custom[d.key] = c.value;
      }
    }
    out.push({ rowNumber: r.rowNumber, employeeId: cur.id, name: cur.display_name, errors, changes, profile, job, custom });
  }
  if (rows.length > MAX_UPDATE_ROWS && out[0]) out[0].errors.push(`The file has ${rows.length} rows; update up to ${MAX_UPDATE_ROWS} at a time.`);
  // reporting loops created by the file as a whole (A → B in one row, B → A in another)
  const managerOf = new Map<string, string | null>([...lk.byNumber.values()].map((p) => [p.id, p.manager_id]));
  for (const r of out) if (r.employeeId && r.job.manager_id) managerOf.set(r.employeeId, r.job.manager_id);
  for (const r of out) {
    if (!r.employeeId || !r.job.manager_id) continue;
    let at: string | null | undefined = r.job.manager_id, steps = 0;
    while (at && steps++ < 200) { if (at === r.employeeId) { r.errors.push("This would create a reporting loop."); break; } at = managerOf.get(at); }
  }
  return { rows: out, valid: out.length > 0 && out.every((r) => !r.errors.length), changed: out.filter((r) => r.changes.length).length };
}
