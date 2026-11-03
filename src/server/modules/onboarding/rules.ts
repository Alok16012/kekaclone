/** Onboarding rules: template criteria matching, task types, owners, due dates, progress. Pure (no I/O). */
import { addDaysISO, type ISODate } from "@/lib/dates";
import { OWNER_LABEL as EXIT_OWNER_LABEL, type TaskOwner } from "@/server/modules/exits/rules";

export type { TaskOwner };

export const TASK_TYPES = ["simple", "profile_field", "document_upload", "acknowledge", "approval"] as const;
export type TaskType = (typeof TASK_TYPES)[number];
export const TASK_TYPE_LABEL: Record<TaskType, string> = {
  simple: "To-do",
  profile_field: "Fill in a profile detail",
  document_upload: "Upload a document",
  acknowledge: "Read and acknowledge",
  approval: "Approve",
};

/** Profile details a task can ask for, and the profile section that holds each one. */
export const PROFILE_FIELDS = {
  personal_email: { label: "Personal email", section: "contact" },
  mobile: { label: "Mobile number", section: "contact" },
  dob: { label: "Date of birth", section: "personal" },
  gender: { label: "Gender", section: "personal" },
  marital_status: { label: "Marital status", section: "personal" },
  blood_group: { label: "Blood group", section: "personal" },
  nationality: { label: "Nationality (2-letter code)", section: "personal" },
} as const;
export type ProfileField = keyof typeof PROFILE_FIELDS;
export const isProfileField = (f: unknown): f is ProfileField => typeof f === "string" && f in PROFILE_FIELDS;

export const DOC_CATEGORIES = ["identity", "education", "experience", "other"] as const;
export type DocCategory = (typeof DOC_CATEGORIES)[number];

export type TaskConfig = {
  description?: string | null;
  owner?: TaskOwner;
  field?: ProfileField;              // profile_field
  docType?: string; category?: DocCategory;   // document_upload
  documentId?: string;               // set when uploaded
  ackText?: string;                  // acknowledge
  acknowledgedAt?: string;
  decision?: "approved" | "declined"; decisionNote?: string | null;   // approval
  completedBy?: string | null;       // user id (null: joiner via the portal)
};

/** Which people a template applies to. Empty or missing lists mean "any". */
export type Criteria = { department_ids?: string[]; location_ids?: string[]; designation_ids?: string[]; legal_entity_ids?: string[] };
export type JoinerPlacement = { department_id: string | null; location_id: string | null; designation_id: string | null; legal_entity_id: string | null };
const CRITERIA_KEYS = [["department_ids", "department_id"], ["location_ids", "location_id"], ["designation_ids", "designation_id"], ["legal_entity_ids", "legal_entity_id"]] as const;

export function cleanCriteria(c: Criteria | null | undefined): Criteria {
  const out: Criteria = {};
  for (const [k] of CRITERIA_KEYS) {
    const ids = [...new Set((c?.[k] ?? []).filter((x) => typeof x === "string" && x))];
    if (ids.length) out[k] = ids;
  }
  return out;
}

/** -1 if the template doesn't apply; otherwise how many criteria it narrows by (more = more specific). */
export function matchScore(criteria: Criteria, p: JoinerPlacement): number {
  let score = 0;
  for (const [k, col] of CRITERIA_KEYS) {
    const ids = criteria[k];
    if (!ids?.length) continue;
    if (!p[col] || !ids.includes(p[col]!)) return -1;
    score++;
  }
  return score;
}

/** The template to use for a joiner: the most specific one that applies; ties go to the oldest. */
export function pickTemplate<T extends { id: string; criteria: Criteria; created_at: Date | string }>(templates: T[], p: JoinerPlacement): T | null {
  let best: T | null = null, bestScore = -1;
  const sorted = [...templates].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  for (const t of sorted) {
    const s = matchScore(cleanCriteria(t.criteria), p);
    if (s > bestScore) { best = t; bestScore = s; }
  }
  return best;
}

/** Due date: joining date plus the item's offset (negative = before the first day). */
export const dueDate = (joining: ISODate, offsetDays: number) => addDaysISO(joining, offsetDays);

export const offsetLabel = (n: number) =>
  n === 0 ? "On the joining day" : n < 0 ? `${-n} ${n === -1 ? "day" : "days"} before joining` : `${n} ${n === 1 ? "day" : "days"} after joining`;

export const ownerLabel = (o: TaskOwner) => (o.type === "self" ? "New joiner" : EXIT_OWNER_LABEL(o));

export type TaskStatus = "open" | "done" | "skipped";
export const isOverdue = (t: { status: TaskStatus; due_date: ISODate | null }, today: ISODate) => t.status === "open" && !!t.due_date && t.due_date < today;

/** Progress over tasks that still count (skipped ones drop out). */
export function progress(tasks: { status: TaskStatus; due_date: ISODate | null }[], today: ISODate) {
  const counted = tasks.filter((t) => t.status !== "skipped");
  const done = counted.filter((t) => t.status === "done").length;
  return { total: counted.length, done, overdue: tasks.filter((t) => isOverdue(t, today)).length, pct: counted.length ? Math.round((done / counted.length) * 100) : 100 };
}

/** A process is finished once nothing is left open. */
export const allClosed = (tasks: { status: TaskStatus }[]) => tasks.every((t) => t.status !== "open");

export type ItemInput = { title: string; description?: string | null; type: TaskType; owner: TaskOwner; dueOffsetDays: number; config?: TaskConfig };

/** Validates one template item. Returns an error message, or null when it's fine. */
export function validateItem(i: ItemInput): { error: string; field: string } | null {
  if (!i.title.trim()) return { error: "Give the task a title.", field: "title" };
  if (i.title.trim().length > 160) return { error: "Keep the title under 160 characters.", field: "title" };
  if (!(TASK_TYPES as readonly string[]).includes(i.type)) return { error: "Pick a task type.", field: "type" };
  if (!Number.isInteger(i.dueOffsetDays) || i.dueOffsetDays < -90 || i.dueOffsetDays > 180) return { error: "Due date must be between 90 days before and 180 days after joining.", field: "dueOffsetDays" };
  const o = i.owner;
  if (!o || !["self", "manager", "role", "employee"].includes(o.type)) return { error: "Pick who owns this task.", field: "owner" };
  if (o.type === "role" && !o.role) return { error: "Pick a role.", field: "owner" };
  if (o.type === "employee" && !o.id) return { error: "Pick a person.", field: "owner" };
  if (i.type === "profile_field" && !isProfileField(i.config?.field)) return { error: "Pick the profile detail to fill in.", field: "field" };
  if (i.type === "document_upload") {
    if (!i.config?.docType?.trim()) return { error: "Say which document, e.g. PAN card.", field: "docType" };
    if (!(DOC_CATEGORIES as readonly string[]).includes(i.config?.category ?? "")) return { error: "Pick a document category.", field: "category" };
  }
  if (i.type === "profile_field" || i.type === "document_upload") {
    if (o.type !== "self") return { error: "Only the new joiner can fill in their own details or upload their documents.", field: "owner" };
  }
  if (i.type === "approval" && o.type === "self") return { error: "The new joiner can't approve their own onboarding.", field: "owner" };
  return null;
}

/** Config kept on the template item / copied onto each task, trimmed to what the type uses. */
export function itemConfig(i: ItemInput): TaskConfig {
  const c = i.config ?? {};
  switch (i.type) {
    case "profile_field": return { field: c.field };
    case "document_upload": return { docType: c.docType?.trim().slice(0, 80), category: c.category };
    case "acknowledge": return { ackText: c.ackText?.trim().slice(0, 4000) || undefined };
    default: return {};
  }
}

/** What finishing a task needs, by type (shown on buttons and checked on the server). */
export type CompleteInput =
  | { kind: "done" }
  | { kind: "acknowledge" }
  | { kind: "decide"; decision: "approved" | "declined"; note?: string | null }
  | { kind: "field"; value: string }
  | { kind: "document"; documentId: string };

export function completionAllowed(type: TaskType, input: CompleteInput["kind"]): boolean {
  switch (type) {
    case "simple": return input === "done";
    case "acknowledge": return input === "acknowledge";
    case "approval": return input === "decide";
    case "profile_field": return input === "field" || input === "done";   // "done" only when the detail is already there
    case "document_upload": return input === "document";
  }
}

export const DEFAULT_ONBOARDING_TASKS: (ItemInput & { description: string })[] = [
  { title: "Share your personal email", description: "We use it for payslips and to reach you before your first day.", type: "profile_field", owner: { type: "self" }, dueOffsetDays: -3, config: { field: "personal_email" } },
  { title: "Upload your PAN card", description: "Needed for payroll and tax.", type: "document_upload", owner: { type: "self" }, dueOffsetDays: 0, config: { docType: "PAN card", category: "identity" } },
  { title: "Read the employee handbook", description: "Leave, attendance, conduct and the policies that apply to you.", type: "acknowledge", owner: { type: "self" }, dueOffsetDays: 3, config: { ackText: "I have read the employee handbook and agree to follow the policies in it." } },
  { title: "Set up laptop and accounts", description: "Laptop, email, chat and the tools the role needs, ready on day one.", type: "simple", owner: { type: "role", role: "global_admin" }, dueOffsetDays: -1 },
  { title: "Plan the first week", description: "Introductions, a buddy and the first piece of work.", type: "simple", owner: { type: "manager" }, dueOffsetDays: 0 },
  { title: "Confirm documents are in order", description: "Check the joiner's documents and approve their joining formalities.", type: "approval", owner: { type: "role", role: "hr_admin" }, dueOffsetDays: 7 },
];
