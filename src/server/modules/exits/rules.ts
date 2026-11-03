/** Exit rules: notice period, last working day, state machine, checklist owners. Pure (no I/O). */
import { addDaysISO, fromISO, type ISODate } from "@/lib/dates";

export type ExitKind = "resignation" | "company_action";
export type ExitStatus = "under_review" | "in_progress" | "exited" | "withdrawn" | "rejected";
export type ExitAction = "approve" | "reject" | "withdraw" | "cancel" | "complete";
export type NoticePolicy = { days: number; probation_days: number | null };

export const DEFAULT_NOTICE_POLICIES: { name: string; days: number; probation_days: number | null; is_default?: boolean }[] = [
  { name: "30 days", days: 30, probation_days: 15, is_default: true },
  { name: "60 days", days: 60, probation_days: 30 },
  { name: "90 days", days: 90, probation_days: 30 },
];

export const DEFAULT_EXIT_REASONS: { kind: "resignation" | "termination" | "other"; name: string }[] = [
  { kind: "resignation", name: "Better opportunity" },
  { kind: "resignation", name: "Higher studies" },
  { kind: "resignation", name: "Personal or family reasons" },
  { kind: "resignation", name: "Relocation" },
  { kind: "resignation", name: "Health" },
  { kind: "resignation", name: "Compensation" },
  { kind: "termination", name: "Performance" },
  { kind: "termination", name: "Conduct" },
  { kind: "termination", name: "Role made redundant" },
  { kind: "other", name: "End of contract" },
  { kind: "other", name: "Retirement" },
];

export type TaskOwner = { type: "role"; role: string } | { type: "manager" } | { type: "self" } | { type: "employee"; id: string };

/** Checklist tasks the system can tick on its own (see exits/checklist.ts autoTickExitTasks). */
export const AUTO_KINDS = ["assets_returned", "access_revoked", "fnf_finalized"] as const;
export type AutoKind = (typeof AUTO_KINDS)[number];
export const AUTO_LABEL: Record<AutoKind, string> = {
  assets_returned: "Ticked when every asset issued to the person has been taken back",
  access_revoked: "Ticked when the person's sign-in is disabled (on relieving)",
  fnf_finalized: "Ticked when the final settlement is finalised in Payroll",
};

/** Default exit checklist. due_offset_days is relative to the last working day (negative = before it). */
export const DEFAULT_EXIT_TASKS: { title: string; description: string; owner: TaskOwner; due_offset_days: number; auto?: AutoKind }[] = [
  { title: "Return company assets", description: "Laptop, ID card, access cards and anything else issued to the person.", owner: { type: "self" }, due_offset_days: 0, auto: "assets_returned" },
  { title: "Knowledge transfer", description: "Hand over ongoing work, documents and contacts to the team.", owner: { type: "manager" }, due_offset_days: -3 },
  { title: "Revoke IT access", description: "Email, tools and system accounts closed on the last working day.", owner: { type: "role", role: "global_admin" }, due_offset_days: 0, auto: "access_revoked" },
  { title: "Final settlement", description: "Pay out or recover dues in the full and final settlement.", owner: { type: "role", role: "hr_admin" }, due_offset_days: 30, auto: "fnf_finalized" },
];

/** Notice days that apply: the probation figure while someone is still on probation (if the policy has one). */
export function noticeDays(policy: NoticePolicy | null, inProbation: boolean): number {
  if (!policy) return 0;
  if (inProbation && policy.probation_days != null) return policy.probation_days;
  return policy.days;
}

/** Last working day = resignation date + notice days (0 days → the same day). */
export function lastWorkingDay(resignationDate: ISODate, days: number): ISODate {
  return addDaysISO(resignationDate, Math.max(0, Math.floor(days)));
}

export function daysBetween(a: ISODate, b: ISODate) {
  return Math.round((fromISO(b).getTime() - fromISO(a).getTime()) / 864e5);
}

/** Notice days given up when the agreed last day is earlier than the policy's. */
export function waivedDays(computedLwd: ISODate, actualLwd: ISODate) {
  return Math.max(0, daysBetween(actualLwd, computedLwd));
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Problems with the dates of an exit; empty = fine. Employees resign today; HR may record past resignations. */
export function validateExitDates(i: { resignationDate: ISODate; lastWorkingDate: ISODate; today: ISODate; by: "self" | "hr" }): { field: string; message: string }[] {
  const out: { field: string; message: string }[] = [];
  if (!ISO.test(i.resignationDate)) return [{ field: "resignationDate", message: "Pick the resignation date." }];
  if (!ISO.test(i.lastWorkingDate)) return [{ field: "lastWorkingDate", message: "Pick the last working day." }];
  if (i.lastWorkingDate < i.resignationDate) out.push({ field: "lastWorkingDate", message: "The last working day can't be before the resignation date." });
  if (i.by === "self") {
    if (i.resignationDate !== i.today) out.push({ field: "resignationDate", message: "Your resignation date is today." });
    if (i.lastWorkingDate < i.today) out.push({ field: "lastWorkingDate", message: "Your last working day can't be in the past." });
  } else {
    if (daysBetween(i.resignationDate, i.today) > 365) out.push({ field: "resignationDate", message: "The resignation date can be at most a year ago." });
    if (daysBetween(i.today, i.resignationDate) > 90) out.push({ field: "resignationDate", message: "The resignation date can be at most 90 days ahead." });
  }
  if (daysBetween(i.resignationDate, i.lastWorkingDate) > 365) out.push({ field: "lastWorkingDate", message: "The last working day must be within a year of the resignation date." });
  return out;
}

const TRANSITIONS: Record<ExitStatus, Partial<Record<ExitAction, ExitStatus>>> = {
  under_review: { approve: "in_progress", reject: "rejected", withdraw: "withdrawn", cancel: "withdrawn" },
  in_progress: { complete: "exited", cancel: "withdrawn" },
  exited: {},
  withdrawn: {},
  rejected: {},
};

/** Next status, or null if the action isn't allowed from this status. */
export function nextStatus(from: ExitStatus, action: ExitAction): ExitStatus | null {
  return TRANSITIONS[from]?.[action] ?? null;
}

export const isOpen = (s: ExitStatus) => s === "under_review" || s === "in_progress";

/** Board tab for a status. */
export function stageOf(s: ExitStatus): "review" | "progress" | "exited" | null {
  return s === "under_review" ? "review" : s === "in_progress" ? "progress" : s === "exited" ? "exited" : null;
}

/** The nightly job relieves people the day after their last working day. */
export const dueForRelieving = (lastWorkingDate: ISODate, today: ISODate) => lastWorkingDate < today;
/** HR may complete an exit by hand from the last working day onwards. */
export const canCompleteNow = (lastWorkingDate: ISODate, today: ISODate) => lastWorkingDate <= today;

/** Who a checklist task goes to. Falls back to the role holder (HR) when there's no manager. */
export function resolveOwner(owner: TaskOwner, ctx: { employeeId: string; managerId: string | null; roleHolder: (role: string) => string | null }): string | null {
  switch (owner.type) {
    case "self": return ctx.employeeId;
    case "manager": return ctx.managerId ?? ctx.roleHolder("hr_admin") ?? ctx.roleHolder("global_admin");
    case "employee": return owner.id;
    case "role": return ctx.roleHolder(owner.role) ?? ctx.roleHolder("global_admin");
  }
}

export const OWNER_LABEL = (o: TaskOwner) => o.type === "self" ? "Employee" : o.type === "manager" ? "Manager" : o.type === "role" ? (o.role === "hr_admin" ? "HR" : o.role === "global_admin" ? "Admin" : o.role) : "Named person";
