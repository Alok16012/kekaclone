/**
 * Core HR rules with no I/O, shared by services, the settings UI and tests:
 * custom-field values, approval-workflow conditions, identity numbers, org-chart layout, CSV, probation buckets.
 */

// ---------------------------------------------------------------- custom fields

export const CUSTOM_FIELD_TYPES = ["text", "long_text", "number", "date", "select", "multi_select", "boolean", "email", "phone"] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];
export const CUSTOM_FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  text: "Short text", long_text: "Paragraph", number: "Number", date: "Date", select: "Dropdown", multi_select: "Multiple choice",
  boolean: "Yes / no", email: "Email", phone: "Phone",
};
/** Who may see or edit a field: the person, their managers, HR (people with employees.write for them). */
export const FIELD_ROLES = ["employee", "manager", "hr_admin"] as const;
export type FieldRole = (typeof FIELD_ROLES)[number];
export const FIELD_ROLE_LABELS: Record<FieldRole, string> = { employee: "The employee", manager: "Their managers", hr_admin: "HR" };

export type CustomFieldDef = {
  id: string; key: string; label: string; section: string; type: CustomFieldType; options: string[] | null; required: boolean;
  view_roles: string[]; edit_roles: string[]; position: number; status: "draft" | "published" | "archived";
};

/** Profile access → custom-field role. Colleagues never see custom fields. */
export function fieldRoleFor(access: "self" | "manager" | "admin" | "colleague"): FieldRole | null {
  return access === "admin" ? "hr_admin" : access === "manager" ? "manager" : access === "self" ? "employee" : null;
}
export const canViewField = (d: Pick<CustomFieldDef, "view_roles" | "edit_roles">, role: FieldRole | null) => !!role && (role === "hr_admin" || d.view_roles.includes(role) || d.edit_roles.includes(role));
export const canEditField = (d: Pick<CustomFieldDef, "edit_roles">, role: FieldRole | null) => !!role && (role === "hr_admin" || d.edit_roles.includes(role));

export function slugKey(label: string) {
  return label.trim().toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "field";
}

export type FieldValue = string | number | boolean | string[] | null;

/**
 * Turns raw input (form value or Excel cell text) into the stored value for a field, or an error message.
 * Empty input is null (and an error when the field is required).
 */
export function coerceFieldValue(d: Pick<CustomFieldDef, "type" | "options" | "required" | "label">, raw: unknown): { ok: true; value: FieldValue } | { ok: false; error: string } {
  const empty = raw == null || (typeof raw === "string" && raw.trim() === "") || (Array.isArray(raw) && raw.length === 0);
  if (empty) return d.required ? { ok: false, error: `${d.label} is required.` } : { ok: true, value: null };
  const text = Array.isArray(raw) ? raw.map(String) : String(raw).trim();
  const opts = d.options ?? [];
  const findOpt = (s: string) => opts.find((o) => o.toLowerCase() === s.trim().toLowerCase());
  switch (d.type) {
    case "text": case "long_text": {
      const s = String(text);
      const max = d.type === "text" ? 200 : 2000;
      return s.length > max ? { ok: false, error: `${d.label} can be at most ${max} characters.` } : { ok: true, value: s };
    }
    case "number": {
      const n = typeof raw === "number" ? raw : Number(String(text).replace(/,/g, ""));
      return Number.isFinite(n) && Math.abs(n) < 1e12 ? { ok: true, value: n } : { ok: false, error: `${d.label} must be a number.` };
    }
    case "date": {
      const s = raw instanceof Date ? raw.toISOString().slice(0, 10) : String(text);
      const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s), dmy = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(s);   // Indian order, never MM/DD
      if (!ymd && !dmy) return { ok: false, error: `${d.label} must be a date (YYYY-MM-DD).` };
      const iso = ymd ? `${ymd[1]}-${ymd[2]}-${ymd[3]}` : `${dmy![3]}-${dmy![2]}-${dmy![1]}`;
      const dt = new Date(iso + "T00:00:00Z");
      return !isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === iso ? { ok: true, value: iso } : { ok: false, error: `${d.label} must be a real date.` };
    }
    case "select": {
      const o = findOpt(String(text));
      return o ? { ok: true, value: o } : { ok: false, error: `${d.label} must be one of: ${opts.join(", ")}.` };
    }
    case "multi_select": {
      const parts = (Array.isArray(text) ? text : String(text).split(/[,;]/)).map((s) => s.trim()).filter(Boolean);
      const out: string[] = [];
      for (const p of parts) { const o = findOpt(p); if (!o) return { ok: false, error: `“${p}” isn't an option for ${d.label}.` }; if (!out.includes(o)) out.push(o); }
      if (!out.length && d.required) return { ok: false, error: `${d.label} is required.` };
      return { ok: true, value: out.length ? out : null };
    }
    case "boolean": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      const s = String(text).toLowerCase();
      if (["yes", "y", "true", "1"].includes(s)) return { ok: true, value: true };
      if (["no", "n", "false", "0"].includes(s)) return { ok: true, value: false };
      return { ok: false, error: `${d.label} must be yes or no.` };
    }
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(text)) ? { ok: true, value: String(text).toLowerCase() } : { ok: false, error: `${d.label} must be an email address.` };
    case "phone":
      return /^\+?[0-9 ()-]{6,20}$/.test(String(text)) ? { ok: true, value: String(text) } : { ok: false, error: `${d.label} must be a phone number.` };
  }
}

export function displayFieldValue(v: FieldValue): string {
  if (v == null || v === "") return "";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

// ---------------------------------------------------------------- approval workflows

export const CONDITION_FIELDS = ["department", "location", "designation", "legal_entity", "business_unit", "worker_type"] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number];
export const CONDITION_LABELS: Record<ConditionField, string> = {
  department: "Department", location: "Location", designation: "Designation", legal_entity: "Legal entity", business_unit: "Business unit", worker_type: "Worker type",
};
/** Every condition must hold (AND); inside one condition, any listed value matches (OR). [] = everyone. */
export type Condition = { field: ConditionField; values: string[] };
export type RequesterFacts = Partial<Record<ConditionField, string | null>>;

export function matchesConditions(conds: Condition[] | null | undefined, who: RequesterFacts) {
  return (conds ?? []).every((c) => c.values.length === 0 || c.values.includes(String(who[c.field] ?? "")));
}

/** Highest priority first; among equal priority, the more specific (more conditions) wins; [] conditions = catch-all. */
export function pickWorkflow<W extends { priority: number; conditions: Condition[] | null }>(wfs: W[], who: RequesterFacts): W | undefined {
  return [...wfs].sort((a, b) => b.priority - a.priority || (b.conditions?.length ?? 0) - (a.conditions?.length ?? 0)).find((w) => matchesConditions(w.conditions, who));
}

export type LevelSpec = { approver: "manager" | "l2_manager" | "role" | "employee"; role?: string; id?: string };
export function validateLevels(levels: LevelSpec[]): string | null {
  if (levels.length > 6) return "Use at most 6 approval levels.";
  for (const [i, l] of levels.entries()) {
    if (!["manager", "l2_manager", "role", "employee"].includes(l.approver)) return `Level ${i + 1}: choose who approves.`;
    if (l.approver === "role" && !l.role) return `Level ${i + 1}: choose a role.`;
    if (l.approver === "employee" && !l.id) return `Level ${i + 1}: choose a person.`;
  }
  return null;
}

/** Whole days a step has waited (IST calendar days are close enough for "after N days"). */
export const daysWaiting = (since: Date, now: Date) => Math.floor((now.getTime() - since.getTime()) / 86_400_000);

/** Is a delegation active on a date? */
export const delegationActive = (d: { from_date: string; to_date: string | null; cancelled_at?: Date | string | null }, date: string) =>
  !d.cancelled_at && d.from_date <= date && (d.to_date == null || d.to_date >= date);

// ---------------------------------------------------------------- identity documents

export const ID_KINDS = ["pan", "aadhaar", "passport", "voter_id", "driving_licence", "other"] as const;
export type IdKind = (typeof ID_KINDS)[number];
export const ID_LABELS: Record<IdKind, string> = { pan: "PAN", aadhaar: "Aadhaar", passport: "Passport", voter_id: "Voter ID", driving_licence: "Driving licence", other: "Other ID" };

// Verhoeff checksum (Aadhaar's last digit)
const VD = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const VP = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
export function verhoeffValid(num: string) {
  let c = 0;
  const digits = num.split("").reverse().map(Number);
  for (let i = 0; i < digits.length; i++) c = VD[c][VP[i % 8][digits[i]]];
  return c === 0;
}

/** Normalises and checks an ID number; returns the clean value or an error. */
export function normaliseIdNumber(kind: IdKind, raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const s = raw.replace(/[\s-]/g, "").toUpperCase();
  if (!s) return { ok: false, error: "Enter the number." };
  if (kind === "pan") return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(s) ? { ok: true, value: s } : { ok: false, error: "A PAN looks like ABCDE1234F." };
  if (kind === "aadhaar") {
    if (!/^[2-9][0-9]{11}$/.test(s)) return { ok: false, error: "An Aadhaar number has 12 digits and doesn't start with 0 or 1." };
    return verhoeffValid(s) ? { ok: true, value: s } : { ok: false, error: "This Aadhaar number doesn't pass its check digit. Check for a typo." };
  }
  if (kind === "passport") return /^[A-Z][0-9]{7}$/.test(s) ? { ok: true, value: s } : { ok: false, error: "An Indian passport number looks like A1234567." };
  if (kind === "voter_id") return /^[A-Z]{3}[0-9]{7}$/.test(s) ? { ok: true, value: s } : { ok: false, error: "A voter ID (EPIC) looks like ABC1234567." };
  return /^[A-Z0-9/]{4,24}$/.test(s) ? { ok: true, value: s } : { ok: false, error: "Use 4–24 letters and digits." };
}

/** What everyone except an authorised reveal sees: the last four characters. */
export function maskId(kind: IdKind, last4: string | null) {
  const tail = last4 ?? "????";
  if (kind === "aadhaar") return `XXXX XXXX ${tail}`;
  if (kind === "pan") return `XXXXXX${tail}`;
  return `••••${tail}`;
}

// ---------------------------------------------------------------- org chart

export type TreeNode = { id: string; name: string; title: string | null; children: TreeNode[] };
export type Placed = { id: string; name: string; title: string | null; x: number; y: number; parent: string | null };

/**
 * Tidy top-down layout: leaves are placed left to right, a parent sits centred over its children.
 * Returns boxes in pixel units (node w × h, gaps) and the overall size. Used for the PNG and PDF exports.
 */
export function layoutTree(roots: TreeNode[], o: { w: number; h: number; gapX: number; gapY: number } = { w: 180, h: 56, gapX: 24, gapY: 48 }) {
  const out: Placed[] = [];
  let cursor = 0, depthMax = 0;
  const place = (n: TreeNode, depth: number, parent: string | null): number => {
    depthMax = Math.max(depthMax, depth);
    const y = depth * (o.h + o.gapY);
    let x: number;
    if (!n.children.length) { x = cursor; cursor += o.w + o.gapX; }
    else {
      const xs = n.children.map((c) => place(c, depth + 1, n.id));
      x = (xs[0] + xs[xs.length - 1]) / 2;
    }
    out.push({ id: n.id, name: n.name, title: n.title, x, y, parent });
    return x;
  };
  for (const r of roots) place(r, 0, null);
  return { nodes: out, width: Math.max(o.w, cursor - o.gapX), height: (depthMax + 1) * (o.h + o.gapY) - o.gapY, box: o };
}

/** Builds a forest from flat rows (manager_id → children). People whose manager isn't in the set become roots. */
export function buildForest(rows: { id: string; name: string; title: string | null; manager_id: string | null }[], rootId?: string | null): TreeNode[] {
  const byId = new Map(rows.map((r) => [r.id, { id: r.id, name: r.name, title: r.title, children: [] as TreeNode[] }]));
  const parentOf = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];
  for (const r of rows) {
    const n = byId.get(r.id)!;
    const p = r.manager_id && r.manager_id !== r.id ? byId.get(r.manager_id) : undefined;
    if (p) { p.children.push(n); parentOf.set(n.id, p); } else roots.push(n);
  }
  // data imported from elsewhere can contain loops (A → B → A): cut each loop at one person, who becomes a root
  const seen = new Set<string>();
  const walk = (n: TreeNode) => { if (seen.has(n.id)) return; seen.add(n.id); n.children.forEach(walk); };
  roots.forEach(walk);
  for (const n of byId.values()) {
    if (seen.has(n.id)) continue;
    const p = parentOf.get(n.id);
    if (p) p.children = p.children.filter((c) => c.id !== n.id);
    roots.push(n); walk(n);
  }
  const sort = (xs: TreeNode[]) => { xs.sort((a, b) => a.name.localeCompare(b.name)); xs.forEach((x) => sort(x.children)); };
  sort(roots);
  if (rootId) { const r = byId.get(rootId); return r ? [r] : []; }
  return roots;
}

// ---------------------------------------------------------------- export helpers

export function csvCell(v: unknown) {
  const s = v == null ? "" : String(v);
  // spreadsheet formula injection: prefix cells that would be read as a formula
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
export const toCsv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

// ---------------------------------------------------------------- probation

export type ProbationBucket = "overdue" | "due_soon" | "upcoming";
export function probationBucket(endDate: string | null, today: string, soonDays = 15): ProbationBucket {
  if (!endDate || endDate < today) return "overdue";
  const days = Math.round((Date.parse(endDate + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86_400_000);
  return days <= soonDays ? "due_soon" : "upcoming";
}
