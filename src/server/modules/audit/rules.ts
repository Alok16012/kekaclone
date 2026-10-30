/**
 * Audit log: pure helpers shared by the server (descriptions, cursors) and the settings screen (diff viewer).
 * No I/O here, so it is unit-tested and safe to import from client components.
 */

export type AuditRow = {
  entity_type: string;
  action: string;
  diff: unknown;
  /** resolved name of the thing acted on (person, role, department …) when it still exists or was recorded */
  entity_label?: string | null;
  /** resolved name of a second person mentioned in the diff (e.g. who got a role) */
  subject_label?: string | null;
  /** who did it; when it's the same person as the entity, sentences say "their" */
  actor_label?: string | null;
};

/** Entity types that appear in the log, with the words used in filters and sentences. */
export const ENTITY_LABELS: Record<string, string> = {
  employee: "People",
  user: "Accounts and invites",
  role: "Roles",
  tenant: "Company settings",
  leave: "Leave requests",
  profile_change: "Profile change requests",
  attendance_request: "Attendance requests",
  departments: "Departments",
  designations: "Designations",
  locations: "Locations",
  legal_entities: "Legal entities",
  business_units: "Business units",
  bands: "Bands",
  leave_plan: "Leave plan",
  leave_type: "Leave types",
  leave_ledger: "Leave balances",
  holiday_list: "Holiday lists",
  holiday: "Holidays",
  comp_off: "Comp-off claims",
  shift: "Shifts",
  weekly_off_policy: "Weekly offs",
  capture_policy: "Clock-in rules",
  penalization_policy: "Attendance penalties",
  attendance_assignment: "Shift and weekly-off assignments",
  exit: "Exits",
  generated_letter: "Letters",
};

const MASTER_WORD: Record<string, string> = {
  departments: "department", designations: "designation", locations: "location",
  legal_entities: "legal entity", business_units: "business unit", bands: "band",
};

export const SETUP_STEP_WORDS: Record<string, string> = {
  company: "Company", locations: "Locations", departments: "Departments", designations: "Designations",
  leave: "Leave basics", people: "Add people", invite: "Invite",
};

/** Field names that read badly when humanised automatically. */
const FIELD_WORDS: Record<string, string> = {
  department_id: "department", designation_id: "designation", location_id: "location", manager_id: "manager",
  l2_manager_id: "second-level manager", dotted_manager_id: "dotted-line manager", band_id: "band",
  legal_entity_id: "legal entity", business_unit_id: "business unit", dob: "date of birth", pan: "PAN", tan: "TAN",
  uan: "UAN", ifsc: "IFSC", state_code: "state", year_start: "leave year start", parent_id: "parent department",
  head_employee_id: "department head", employeeId: "person", employeeIds: "people", work_email: "work email", personal_email: "personal email",
};

export function fieldLabel(key: string) {
  if (FIELD_WORDS[key]) return FIELD_WORDS[key];
  return key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_id$/, "").replace(/_/g, " ").toLowerCase();
}

const obj = (d: unknown): Record<string, unknown> => (d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : {});
const quote = (s: unknown) => `“${String(s)}”`;
const list = (keys: string[], max = 3) => {
  const words = keys.map(fieldLabel);
  if (words.length <= max) return words.join(", ");
  return `${words.slice(0, max).join(", ")} and ${words.length - max} more`;
};
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** Keys of the fields a diff touches, whatever shape it has. */
export function changedFields(diff: unknown): string[] {
  const d = obj(diff);
  if (d.after && typeof d.after === "object") return Object.keys(obj(d.after));
  if (d.changes && typeof d.changes === "object") return Object.keys(obj(d.changes));
  return Object.keys(d).filter((k) => !["note", "comment", "label", "kind", "effectiveDate", "scheduled", "employeeId"].includes(k) && !(k === "name" && typeof d[k] === "string"));
}

/**
 * The sentence after the actor's name, e.g. "added Arjun Rao" or "changed sign-in codes to Required for everyone".
 * Unknown actions fall back to a plain "<action> · <entity>" so nothing is ever blank.
 */
export function describe(r: AuditRow): string {
  const d = obj(r.diff);
  // a delete records the name at that moment, which beats whatever the id resolves to now
  const recorded = typeof d.name === "string" ? d.name : null;
  const who = (r.action === "delete" && recorded) || r.entity_label || recorded;
  const self = !!who && !!r.actor_label && who === r.actor_label;
  const whose = self ? "their" : who ? `${who}’s` : "a";
  const [base, sub] = r.action.split(".", 2);

  if (base === "approval") {
    const verb = sub === "approved" ? "approved" : sub === "rejected" ? "declined" : sub;
    const thing = r.entity_type === "leave" ? "leave request" : r.entity_type === "profile_change" ? "profile change request" : r.entity_type === "attendance_request" ? "attendance request" : r.entity_type === "comp_off" ? "comp-off claim" : r.entity_type === "exit" ? "resignation" : (ENTITY_LABELS[r.entity_type] ?? r.entity_type).toLowerCase();
    return `${verb} ${whose} ${thing}`;
  }

  if (MASTER_WORD[r.entity_type]) {
    const w = MASTER_WORD[r.entity_type];
    const nm = who ? ` ${quote(who)}` : "";
    if (r.action === "create") return `added the ${w}${nm}`;
    if (r.action === "delete") return `deleted the ${w}${nm}`;
    if (r.action === "update") {
      const n = obj(d.name);
      if ("old" in n && "new" in n && changedFields(d).length === 1) return `renamed the ${w} ${quote(n.old)} to ${quote(n.new)}`;
      const f = changedFields(d);
      return `updated the ${w}${nm}${f.length ? ` (${list(f)})` : ""}`;
    }
  }

  switch (r.entity_type) {
    case "employee":
      if (r.action === "create") return `added ${who ?? "a person"}`;
      if (r.action === "bulk_import") return `imported ${plural(Number(d.count ?? 0), "person", "people")} from a spreadsheet`;
      if (r.action === "update") { const f = changedFields(d); return `updated ${whose} profile${f.length ? ` (${list(f)})` : ""}`; }
      if (r.action === "job_change") { const f = changedFields(d); return `changed ${whose} job details${f.length ? ` (${list(f)})` : ""}`; }
      if (r.action === "job_change_scheduled") { const f = changedFields(d); return `scheduled a job change for ${who ?? "someone"}${d.effectiveDate ? ` from ${d.effectiveDate}` : ""}${f.length ? ` (${list(f)})` : ""}`; }
      if (r.action === "job_change_cancelled") return `cancelled a scheduled job change for ${who ?? "someone"}`;
      if (r.action === "probation") {
        const a = d.action;
        if (a === "confirm") return `confirmed ${whose} probation`;
        if (a === "extend") return `extended ${whose} probation${d.until ? ` to ${d.until}` : ""}`;
        return `started probation for ${who ?? "someone"}${d.until ? ` until ${d.until}` : ""}`;
      }
      break;
    case "profile_change":
      if (r.action === "submit") { const f = changedFields(d); return `asked HR to approve changes to ${whose} profile${f.length ? ` (${list(f)})` : ""}`; }
      break;
    case "role": {
      const role = who ? ` ${quote(who)}` : "";
      const person = r.subject_label ?? "someone";
      if (r.action === "save" || r.action === "create" || r.action === "update") {
        const perms = Array.isArray(d.permissions) ? d.permissions.length : null;
        return `saved the role${role}${perms !== null ? ` with ${plural(perms, "permission")}` : ""}`;
      }
      if (r.action === "delete") return `deleted the role${role}`;
      if (r.action === "assign") {
        const scoped = Array.isArray(d.scopes) && d.scopes.length > 0;
        return `gave ${person} the role${role}${scoped ? " for part of the company" : ""}`;
      }
      if (r.action === "unassign") return `removed the role${role} from ${person}`;
      break;
    }
    case "tenant":
      if (r.action === "security.mfa") {
        const m = { off: "Off", optional: "Each person decides", required: "Required for everyone" }[String(d.mode)] ?? String(d.mode);
        return `set sign-in codes to ${m}`;
      }
      if (r.action === "create") return "created the workspace";
      if (r.action === "setup.step") {
        const step = SETUP_STEP_WORDS[String(d.step)] ?? String(d.step);
        return d.status === "skipped" ? `skipped the setup step ${quote(step)}` : `completed the setup step ${quote(step)}`;
      }
      if (r.action === "setup.finish") return "finished company setup";
      if (r.action === "setup.start") return "started company setup";
      break;
    case "leave_plan":
      if (r.action === "update") { const f = changedFields(d); return `updated leave basics${f.length ? ` (${list(f, 4)})` : ""}`; }
      break;
    case "user":
      if (r.action === "invite") return Number(d.count) === 1 && r.subject_label ? `sent an invite to ${r.subject_label}` : `sent ${plural(Number(d.count ?? 0), "invite")}`;
      if (r.action === "invite_accepted") return "accepted their invite and set a password";
      if (r.action === "password_reset") return "reset their password";
      if (r.action === "security.my_mfa") return d.on ? "turned on sign-in codes for their account" : "turned off sign-in codes for their account";
      if (r.action === "device.trusted") return "chose to remember a device for 30 days";
      break;
    case "leave":
      if (r.action === "create") return "applied for leave";
      if (r.action === "cancel") return `cancelled ${whose} leave request`;
      break;
  }
  const entity = (ENTITY_LABELS[r.entity_type] ?? r.entity_type).toLowerCase();
  return `${r.action.replace(/[._]/g, " ")} · ${entity}${who ? ` ${quote(who)}` : ""}`;
}

export type DiffLine = { field: string; label: string; before?: unknown; after?: unknown; value?: unknown };

/**
 * Flattens the few diff shapes the app writes into rows for the viewer:
 *   {field: {old, new}}           → before/after per field
 *   {before: {...}, after: {...}} → before/after per field
 *   {changes: {field: {old,new}}} → before/after per field (plus other top-level keys as values)
 *   anything else                 → one value row per key
 */
export function diffLines(diff: unknown): DiffLine[] {
  const d = obj(diff);
  const out: DiffLine[] = [];
  const isPair = (v: unknown) => { const o = obj(v); return "old" in o || "new" in o; };
  if (d.before !== undefined || d.after !== undefined) {
    const b = obj(d.before), a = obj(d.after);
    for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) out.push({ field: k, label: fieldLabel(k), before: b[k] ?? null, after: a[k] ?? null });
    for (const [k, v] of Object.entries(d)) if (k !== "before" && k !== "after" && v !== null && v !== undefined) out.push({ field: k, label: fieldLabel(k), value: v });
    return out;
  }
  for (const [k, v] of Object.entries(d)) {
    if (k === "changes" && v && typeof v === "object") {
      for (const [ck, cv] of Object.entries(obj(v))) {
        out.push(isPair(cv) ? { field: ck, label: fieldLabel(ck), before: obj(cv).old ?? null, after: obj(cv).new ?? null } : { field: ck, label: fieldLabel(ck), after: cv });
      }
    } else if (isPair(v)) out.push({ field: k, label: fieldLabel(k), before: obj(v).old ?? null, after: obj(v).new ?? null });
    else out.push({ field: k, label: fieldLabel(k), value: v });
  }
  return out;
}

/** Display a diff value: null → "—", objects as compact JSON. */
export function showValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** "30 Oct 2026, 3:04 pm" in IST. Done on the server so server and browser render the same text. */
export function formatWhen(iso: string, timeZone = "Asia/Kolkata") {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-IN", { timeZone, day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true }).format(d);
}

// ---------- cursors (newest first, ties broken by id) ----------

export type Cursor = { at: string; id: string };

export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.at}|${c.id}`, "utf8").toString("base64url");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

/** Returns null for anything that isn't a cursor this app produced (bad input never reaches SQL). */
export function decodeCursor(s: string | null | undefined): Cursor | null {
  if (!s || s.length > 200) return null;
  let raw: string;
  try { raw = Buffer.from(s, "base64url").toString("utf8"); } catch { return null; }
  const [at, id, extra] = raw.split("|");
  if (extra !== undefined || !at || !id || !TS.test(at) || !UUID.test(id)) return null;
  return { at, id };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
export type AuditFilters = { actor?: string | null; entity?: string | null; action?: string | null; from?: string | null; to?: string | null };

/** Cleans filters from the URL: unknown/invalid values are dropped, and a reversed date range is swapped. */
export function cleanFilters(f: Record<string, string | string[] | undefined>): AuditFilters {
  const one = (k: string) => { const v = f[k]; const s = Array.isArray(v) ? v[0] : v; return s && s.trim() ? s.trim() : null; };
  const actor = one("actor"), entity = one("entity"), action = one("action");
  let from = one("from"), to = one("to");
  if (from && !ISO.test(from)) from = null;
  if (to && !ISO.test(to)) to = null;
  if (from && to && from > to) [from, to] = [to, from];
  return {
    actor: actor && UUID.test(actor) ? actor : null,
    entity: entity && /^[a-z_]{2,40}$/.test(entity) ? entity : null,
    action: action && /^[a-z_.]{2,60}$/.test(action) ? action : null,
    from, to,
  };
}
