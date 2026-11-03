/**
 * Workflow automations: the parts with no I/O. Trigger and action catalogues, condition matching, placeholder
 * rendering, date-trigger arithmetic and input validation. Pure, so they are unit-tested and shared with the
 * settings screen.
 */
import type { ISODate } from "@/lib/dates";
import { addDaysISO } from "@/lib/dates";

export type TriggerKind = "event" | "daily";
export const TRIGGERS = [
  { key: "employee.joined", label: "Someone joins", hint: "When a person is added, on their joining date", kind: "event" },
  { key: "employee.exited", label: "Someone leaves", hint: "When an exit is completed and the person is relieved", kind: "event" },
  { key: "employee.transferred", label: "Someone is transferred", hint: "A department, location, manager or designation change takes effect", kind: "event" },
  { key: "leave.approved", label: "Leave is approved", hint: "A leave request gets its final approval", kind: "event" },
  { key: "ticket.breached", label: "A helpdesk ticket breaches its SLA", hint: "First response or resolution target missed", kind: "event" },
  { key: "review.published", label: "Review results are published", hint: "A person's rating and feedback are released", kind: "event" },
  { key: "birthday", label: "Birthday", hint: "Runs each morning for everyone whose birthday is today", kind: "daily" },
  { key: "work_anniversary", label: "Work anniversary", hint: "Runs each morning on the anniversary of the joining date", kind: "daily" },
  { key: "date_offset", label: "Days before or after a date", hint: "Joining date, probation end, last working day or birthday, shifted by a number of days", kind: "daily" },
] as const;
export type Trigger = (typeof TRIGGERS)[number]["key"];
export const ALL_TRIGGERS: string[] = TRIGGERS.map((t) => t.key);
export const isTrigger = (v: unknown): v is Trigger => typeof v === "string" && ALL_TRIGGERS.includes(v);
export const triggerKind = (t: Trigger): TriggerKind => TRIGGERS.find((x) => x.key === t)!.kind;

export const DATE_FIELDS = [
  { key: "joining_date", label: "Joining date" },
  { key: "probation_end_date", label: "Probation end date" },
  { key: "exit_date", label: "Last working day" },
  { key: "dob", label: "Birthday (this year's)" },
] as const;
export type DateField = (typeof DATE_FIELDS)[number]["key"];
export type TriggerConfig = { field?: DateField; offset_days?: number };

export const CONDITION_FIELDS = [
  { key: "department_id", label: "Department", type: "department" },
  { key: "location_id", label: "Location", type: "location" },
  { key: "designation_id", label: "Designation", type: "designation" },
  { key: "legal_entity_id", label: "Legal entity", type: "legal_entity" },
  { key: "business_unit_id", label: "Business unit", type: "business_unit" },
  { key: "worker_type", label: "Worker type", type: "enum", values: ["permanent", "contract", "intern", "consultant"] },
  { key: "time_type", label: "Time type", type: "enum", values: ["full_time", "part_time"] },
  { key: "probation_status", label: "Probation", type: "enum", values: ["none", "in_probation", "extended", "confirmed"] },
  { key: "leave.type_code", label: "Leave type code", type: "text" },
  { key: "leave.days", label: "Leave days", type: "number" },
  { key: "ticket.priority", label: "Ticket priority", type: "enum", values: ["low", "medium", "high"] },
  { key: "ticket.category", label: "Ticket category", type: "text" },
  { key: "years", label: "Years completed (anniversary)", type: "number" },
] as const;
export type ConditionField = (typeof CONDITION_FIELDS)[number]["key"];
export const OPS = ["eq", "neq", "in", "not_in", "gte", "lte", "contains"] as const;
export type Op = (typeof OPS)[number];
export const OP_LABELS: Record<Op, string> = { eq: "is", neq: "is not", in: "is one of", not_in: "is none of", gte: "is at least", lte: "is at most", contains: "contains" };
export type Condition = { field: ConditionField; op: Op; value: string | number | string[] };

export const RECIPIENTS = [
  { key: "employee", label: "The person" },
  { key: "manager", label: "Their manager" },
  { key: "l2_manager", label: "Their manager's manager" },
  { key: "hr_admins", label: "HR admins" },
] as const;
/** "employee" | "manager" | "l2_manager" | "hr_admins" | "role:<key>" | "employee:<uuid>" */
export type Recipient = string;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isRecipient = (v: unknown): v is Recipient =>
  typeof v === "string" && (["employee", "manager", "l2_manager", "hr_admins"].includes(v) || /^role:[a-z_]{2,40}$/.test(v) || (v.startsWith("employee:") && UUID.test(v.slice(9))));

export const ACTION_TYPES = [
  { key: "notify", label: "Notify people", hint: "In-app notification (and email, per Settings → Notifications)" },
  { key: "email", label: "Send an email", hint: "A plain email with your subject and text" },
  { key: "task", label: "Create a task", hint: "Shows under My tasks for the owner" },
  { key: "group", label: "Add to a group", hint: "Adds the person to a group (Settings → Groups)" },
  { key: "announcement", label: "Post an announcement", hint: "On the Home wall, for everyone" },
  { key: "webhook", label: "Call a webhook", hint: "POST the event to a URL, signed like every webhook" },
] as const;
export type ActionType = (typeof ACTION_TYPES)[number]["key"];
export type Action =
  | { type: "notify"; to: Recipient[]; title: string; body: string }
  | { type: "email"; to: Recipient[]; subject: string; body: string }
  | { type: "task"; to: Recipient; title: string; due_days: number }
  | { type: "group"; group_id: string }
  | { type: "announcement"; title: string; body: string }
  | { type: "webhook"; url: string };

export type AutomationInput = { name: string; trigger: Trigger; trigger_config: TriggerConfig; conditions: Condition[]; actions: Action[]; is_active: boolean };

export const PLACEHOLDERS = [
  "employee.name", "employee.first_name", "employee.email", "employee.number", "employee.department", "employee.designation", "employee.location", "employee.joining_date",
  "manager.name", "company", "date", "years", "leave.type", "leave.from", "leave.to", "leave.days", "ticket.number", "ticket.title", "review.cycle",
] as const;

/** {{placeholder}} → value; unknown placeholders become empty, braces are never left behind. */
export function render(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{\{\s*([a-z0-9_.]+)\s*\}\}/gi, (_, k: string) => { const v = vars[k]; return v == null ? "" : String(v); });
}

export type Facts = Record<string, string | number | null | undefined>;

function one(c: Condition, actual: string | number | null | undefined): boolean {
  const vals = Array.isArray(c.value) ? c.value.map(String) : [String(c.value)];
  const a = actual == null ? "" : String(actual);
  switch (c.op) {
    case "eq": return a === vals[0];
    case "neq": return a !== vals[0];
    case "in": return vals.includes(a);
    case "not_in": return !vals.includes(a);
    case "gte": return Number(a) >= Number(vals[0]);
    case "lte": return Number(a) <= Number(vals[0]);
    case "contains": return a.toLowerCase().includes(vals[0].toLowerCase());
  }
}

/** Every condition must hold (AND). No conditions = always. */
export function matches(conditions: Condition[], facts: Facts): boolean {
  return conditions.every((c) => one(c, facts[c.field]));
}

export const yearsBetween = (from: ISODate, to: ISODate) => {
  let y = Number(to.slice(0, 4)) - Number(from.slice(0, 4));
  if (to.slice(5) < from.slice(5)) y -= 1;
  return y;
};

/** Does a daily trigger fire for this person today? Returns extra facts (years) when it does, null otherwise. */
export function dailyDue(trigger: Trigger, config: TriggerConfig, person: { dob: ISODate | null; joining_date: ISODate; probation_end_date: ISODate | null; exit_date: ISODate | null }, today: ISODate): Facts | null {
  const sameDay = (d: ISODate | null) => !!d && (d.slice(5) === today.slice(5) || (d.slice(5) === "02-29" && today.slice(5) === "02-28" && !leap(today)));
  if (trigger === "birthday") return sameDay(person.dob) ? { years: yearsBetween(person.dob!, today) } : null;
  if (trigger === "work_anniversary") {
    const years = yearsBetween(person.joining_date, today);
    return sameDay(person.joining_date) && years >= 1 ? { years } : null;
  }
  if (trigger === "date_offset") {
    const field = config.field ?? "joining_date";
    const offset = Number.isInteger(config.offset_days) ? (config.offset_days as number) : 0;
    let base: ISODate | null = person[field];
    if (!base) return null;
    if (field === "dob") base = `${today.slice(0, 4)}${base.slice(4)}`;   // this year's birthday
    return addDaysISO(base, offset) === today ? { years: yearsBetween(base, today) } : null;
  }
  return null;
}
const leap = (d: ISODate) => { const y = Number(d.slice(0, 4)); return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; };

/** One run per automation per occurrence: events carry their own id, daily triggers use the date. */
export const dedupeKey = (subjectId: string | null, occurrence: string) => `${subjectId ?? "-"}:${occurrence}`;

export const LIMITS = { name: 80, text: 2000, title: 160, actions: 8, conditions: 10 };

export type Problem = { message: string; field?: string };
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Validate and normalise what the editor sends. Returns the clean automation or a problem to show. */
export function validateAutomation(raw: unknown): { ok: true; value: AutomationInput } | { ok: false; problem: Problem } {
  const bad = (message: string, field?: string) => ({ ok: false as const, problem: { message, field } });
  const r = (raw ?? {}) as Record<string, unknown>;
  const name = str(r.name, LIMITS.name);
  if (!name) return bad("Give the automation a name.", "name");
  if (!isTrigger(r.trigger)) return bad("Pick what starts the automation.", "trigger");
  const trigger = r.trigger;
  const cfg = (r.trigger_config ?? {}) as Record<string, unknown>;
  const trigger_config: TriggerConfig = {};
  if (trigger === "date_offset") {
    if (!DATE_FIELDS.some((f) => f.key === cfg.field)) return bad("Pick which date the automation counts from.", "trigger_config");
    const off = Number(cfg.offset_days);
    if (!Number.isInteger(off) || Math.abs(off) > 365) return bad("Days before or after must be a whole number within a year.", "trigger_config");
    trigger_config.field = cfg.field as DateField; trigger_config.offset_days = off;
  }
  const conds = Array.isArray(r.conditions) ? r.conditions : [];
  if (conds.length > LIMITS.conditions) return bad(`At most ${LIMITS.conditions} conditions.`, "conditions");
  const conditions: Condition[] = [];
  for (const c of conds as Record<string, unknown>[]) {
    const f = CONDITION_FIELDS.find((x) => x.key === c.field);
    if (!f) return bad("One of the conditions uses an unknown field.", "conditions");
    if (!OPS.includes(c.op as Op)) return bad("One of the conditions uses an unknown comparison.", "conditions");
    const op = c.op as Op;
    const multi = op === "in" || op === "not_in";
    let value: string | number | string[];
    if (multi) {
      const vs = (Array.isArray(c.value) ? c.value : [c.value]).map((v) => str(v, 200)).filter(Boolean);
      if (!vs.length) return bad(`Pick at least one value for ${f.label}.`, "conditions");
      value = vs;
    } else if (f.type === "number" || op === "gte" || op === "lte") {
      const n = Number(Array.isArray(c.value) ? c.value[0] : c.value);
      if (!Number.isFinite(n)) return bad(`${f.label} needs a number.`, "conditions");
      value = n;
    } else {
      value = str(Array.isArray(c.value) ? c.value[0] : c.value, 200);
      if (!value) return bad(`${f.label} needs a value.`, "conditions");
    }
    if (f.type === "enum" && !multi && !(f.values as readonly string[]).includes(String(value))) return bad(`${f.label}: unknown value.`, "conditions");
    conditions.push({ field: f.key, op, value });
  }
  const acts = Array.isArray(r.actions) ? r.actions : [];
  if (!acts.length) return bad("Add at least one action.", "actions");
  if (acts.length > LIMITS.actions) return bad(`At most ${LIMITS.actions} actions.`, "actions");
  const actions: Action[] = [];
  for (const a of acts as Record<string, unknown>[]) {
    const to = (Array.isArray(a.to) ? a.to : a.to ? [a.to] : []).filter(isRecipient) as Recipient[];
    switch (a.type) {
      case "notify": {
        const title = str(a.title, LIMITS.title), body = str(a.body, LIMITS.text);
        if (!to.length) return bad("Notify: pick who to tell.", "actions");
        if (!title) return bad("Notify: add a title.", "actions");
        actions.push({ type: "notify", to: [...new Set(to)], title, body }); break;
      }
      case "email": {
        const subject = str(a.subject, LIMITS.title), body = str(a.body, LIMITS.text);
        if (!to.length) return bad("Email: pick who to send to.", "actions");
        if (!subject || !body) return bad("Email: add a subject and a message.", "actions");
        actions.push({ type: "email", to: [...new Set(to)], subject, body }); break;
      }
      case "task": {
        const title = str(a.title, LIMITS.title), due = Number(a.due_days ?? 0);
        if (!to[0]) return bad("Task: pick an owner.", "actions");
        if (!title) return bad("Task: add a title.", "actions");
        if (!Number.isInteger(due) || due < 0 || due > 365) return bad("Task: due in 0–365 days.", "actions");
        actions.push({ type: "task", to: to[0], title, due_days: due }); break;
      }
      case "group": {
        if (!UUID.test(String(a.group_id ?? ""))) return bad("Add to group: pick a group.", "actions");
        actions.push({ type: "group", group_id: String(a.group_id) }); break;
      }
      case "announcement": {
        const title = str(a.title, LIMITS.title), body = str(a.body, LIMITS.text);
        if (!title || !body) return bad("Announcement: add a title and text.", "actions");
        actions.push({ type: "announcement", title, body }); break;
      }
      case "webhook": {
        const url = str(a.url, 500);
        if (!/^https:\/\/[^\s]+$/.test(url)) return bad("Webhook: enter an https:// URL.", "actions");
        actions.push({ type: "webhook", url }); break;
      }
      default: return bad("One of the actions has an unknown type.", "actions");
    }
  }
  return { ok: true, value: { name, trigger, trigger_config, conditions, actions, is_active: r.is_active !== false } };
}

/** Short human text for the list: "Someone joins · 2 conditions · notify, task". */
export function describe(a: Pick<AutomationInput, "trigger" | "conditions" | "actions" | "trigger_config">) {
  const t = TRIGGERS.find((x) => x.key === a.trigger)?.label ?? a.trigger;
  const cfg = a.trigger === "date_offset" && a.trigger_config.field
    ? ` (${Math.abs(a.trigger_config.offset_days ?? 0)} days ${(a.trigger_config.offset_days ?? 0) < 0 ? "before" : "after"} ${DATE_FIELDS.find((f) => f.key === a.trigger_config.field)?.label.toLowerCase()})` : "";
  const c = a.conditions.length ? ` · ${a.conditions.length} ${a.conditions.length === 1 ? "condition" : "conditions"}` : "";
  const acts = [...new Set(a.actions.map((x) => ACTION_TYPES.find((y) => y.key === x.type)?.label.toLowerCase() ?? x.type))].join(", ");
  return `${t}${cfg}${c} · ${acts}`;
}
