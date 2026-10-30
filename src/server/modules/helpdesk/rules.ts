/** Helpdesk rules: ticket states, SLA clocks and breach flags, escalation, auto-assignment, category checks. Pure (no I/O). */

export type TicketStatus = "open" | "in_progress" | "closed";
export type Priority = "low" | "medium" | "high";
export type TicketAction = "start" | "close" | "reopen";

export const STATUS_LABEL: Record<TicketStatus, string> = { open: "Open", in_progress: "In progress", closed: "Closed" };
export const PRIORITY_LABEL: Record<Priority, string> = { low: "Low", medium: "Medium", high: "High" };
export const PRIORITIES: Priority[] = ["low", "medium", "high"];

/** Starter categories for a new company (no agents yet: helpdesk admins handle them until someone is assigned). */
export const DEFAULT_TICKET_CATEGORIES: { name: string; priority: Priority; first: number; resolution: number }[] = [
  { name: "IT support", priority: "high", first: 4 * 60, resolution: 2 * 24 * 60 },
  { name: "HR questions", priority: "medium", first: 8 * 60, resolution: 3 * 24 * 60 },
  { name: "Payroll and reimbursements", priority: "medium", first: 8 * 60, resolution: 5 * 24 * 60 },
];

const TRANSITIONS: Record<TicketStatus, Partial<Record<TicketAction, TicketStatus>>> = {
  open: { start: "in_progress", close: "closed" },
  in_progress: { close: "closed" },
  closed: { reopen: "open" },
};

/** The status after an action, or null when the action doesn't apply in this state. */
export function nextStatus(from: TicketStatus, action: TicketAction): TicketStatus | null {
  return TRANSITIONS[from][action] ?? null;
}

/** Which actions each side may take. Requesters can close their own ticket or reopen it; agents can do everything. */
export function allowedActions(status: TicketStatus, role: "requester" | "agent"): TicketAction[] {
  const all = Object.keys(TRANSITIONS[status]) as TicketAction[];
  return role === "agent" ? all : all.filter((a) => a !== "start");
}

/** A due time `minutes` after `from`; no SLA → null. */
export function dueAt(from: Date, minutes: number | null | undefined): Date | null {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return null;
  return new Date(from.getTime() + Math.round(minutes) * 60_000);
}

export type SlaClock = "none" | "met" | "on_track" | "due_soon" | "breached";
export type SlaInput = {
  status: TicketStatus;
  first_response_due_at: Date | null; first_responded_at: Date | null;
  resolution_due_at: Date | null; closed_at: Date | null;
};

const SOON_MS = 60 * 60_000;   // last hour before a deadline

function clock(due: Date | null, doneAt: Date | null, now: Date): SlaClock {
  if (!due) return "none";
  if (doneAt) return doneAt.getTime() <= due.getTime() ? "met" : "breached";
  const left = due.getTime() - now.getTime();
  return left < 0 ? "breached" : left <= SOON_MS ? "due_soon" : "on_track";
}

/**
 * SLA flags, computed on read so they're always current: first response (met by the first agent reply) and resolution
 * (met by closing). A ticket closed without any agent reply counts its first response as answered at closing.
 */
export function slaState(t: SlaInput, now: Date) {
  const firstDone = t.first_responded_at ?? (t.status === "closed" ? t.closed_at : null);
  const first = clock(t.first_response_due_at, firstDone, now);
  const resolution = clock(t.resolution_due_at, t.status === "closed" ? t.closed_at : null, now);
  return { first, resolution, breached: first === "breached" || resolution === "breached" };
}

export type EscalationInput = SlaInput & { first_response_escalated_at: Date | null; resolution_escalated_at: Date | null };

/** Escalations that are due and haven't been sent yet. Closed tickets never escalate. */
export function escalationsDue(t: EscalationInput, now: Date): ("first_response" | "resolution")[] {
  if (t.status === "closed") return [];
  const out: ("first_response" | "resolution")[] = [];
  if (!t.first_response_escalated_at && !t.first_responded_at && t.first_response_due_at && t.first_response_due_at.getTime() < now.getTime()) out.push("first_response");
  if (!t.resolution_escalated_at && t.resolution_due_at && t.resolution_due_at.getTime() < now.getTime()) out.push("resolution");
  return out;
}

/** Auto-assign: the category agent with the fewest open tickets; ties go to the one listed first. Never the requester. */
export function pickAssignee(agents: string[], openCounts: Record<string, number>, requesterId: string): string | null {
  let best: string | null = null;
  for (const a of agents) {
    if (a === requesterId) continue;
    if (best == null || (openCounts[a] ?? 0) < (openCounts[best] ?? 0)) best = a;
  }
  return best;
}

export const ticketRef = (n: number | bigint) => `HD-${String(n).padStart(4, "0")}`;

const MAX_SLA_MINUTES = 90 * 24 * 60;

export type CategoryInput = { name: string; priority: string; firstResponseMins: number | null; resolutionMins: number | null; assigneeIds: string[]; escalateToId: string | null };

/** Problems with a category; empty = fine. */
export function validateCategory(c: CategoryInput): { field: string; message: string }[] {
  const out: { field: string; message: string }[] = [];
  if (!c.name.trim()) out.push({ field: "name", message: "Give the category a name." });
  if (c.name.trim().length > 80) out.push({ field: "name", message: "Keep the name under 80 characters." });
  if (!(PRIORITIES as string[]).includes(c.priority)) out.push({ field: "priority", message: "Pick a priority." });
  for (const [k, v, label] of [["firstResponseMins", c.firstResponseMins, "first response"], ["resolutionMins", c.resolutionMins, "resolution"]] as const) {
    if (v == null) continue;
    if (!Number.isInteger(v) || v <= 0) out.push({ field: k, message: `The ${label} time must be a whole number of minutes above zero.` });
    else if (v > MAX_SLA_MINUTES) out.push({ field: k, message: `The ${label} time can be at most 90 days.` });
  }
  if (c.firstResponseMins && c.resolutionMins && c.resolutionMins < c.firstResponseMins)
    out.push({ field: "resolutionMins", message: "Resolution can't be due before the first response." });
  if (new Set(c.assigneeIds).size !== c.assigneeIds.length) out.push({ field: "assigneeIds", message: "Someone is listed twice." });
  if (c.assigneeIds.length > 50) out.push({ field: "assigneeIds", message: "Pick at most 50 agents." });
  return out;
}

/** "4 h", "2 days", "1 day 6 h", "45 min": how SLA minutes read in lists. */
export function formatMinutes(m: number | null | undefined): string {
  if (!m) return "No target";
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), min = m % 60;
  const parts = [d ? `${d} ${d === 1 ? "day" : "days"}` : "", h ? `${h} h` : "", min ? `${min} min` : ""].filter(Boolean);
  return parts.join(" ");
}

export const MAX_ATTACHMENTS = 3;
