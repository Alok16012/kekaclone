/**
 * Every notification event erp sends, grouped for the settings page, with its default channels. Pure: shared by the
 * server (which channels to use) and the UI (what to list). Unknown kinds fall back to the group default.
 */
export type Channel = "in_app" | "email";

export type NotificationEvent = { key: string; label: string; defaults: Channel[]; /** email-only events can't be switched to in-app */ emailOnly?: boolean };
export type EventGroup = { group: string; events: NotificationEvent[] };

export const NOTIFICATION_EVENTS: EventGroup[] = [
  { group: "Approvals", events: [
    { key: "approval.pending", label: "A request is waiting for your approval", defaults: ["in_app", "email"] },
    { key: "request.approved", label: "Your request was approved (leave, attendance, expenses, exits …)", defaults: ["in_app", "email"] },
    { key: "request.rejected", label: "Your request was declined", defaults: ["in_app", "email"] },
    { key: "approvals.digest", label: "Daily digest of everything waiting for your approval", defaults: ["email"], emailOnly: true },
  ] },
  { group: "Leave and attendance", events: [
    { key: "leave.fyi", label: "A colleague is going on leave (FYI)", defaults: ["in_app"] },
    { key: "leave.adjusted", label: "Your leave balance was adjusted or leave was granted for an event", defaults: ["in_app", "email"] },
    { key: "leave.on_behalf", label: "Someone applied for leave on your behalf", defaults: ["in_app", "email"] },
    { key: "attendance.clock_in_review", label: "Your first clock-in from a new device is waiting for approval", defaults: ["in_app"] },
    { key: "attendance.overtime", label: "Overtime settled into payroll or comp-off", defaults: ["in_app", "email"] },
    { key: "attendance.roster", label: "Your shift roster changed", defaults: ["in_app"] },
  ] },
  { group: "Company", events: [
    { key: "engage.announcement", label: "New announcement", defaults: ["in_app", "email"] },
    { key: "engage.praise", label: "Someone praised you", defaults: ["in_app"] },
    { key: "document.ack", label: "A document needs your acknowledgement", defaults: ["in_app", "email"] },
    { key: "letter.issued", label: "A letter was issued to you", defaults: ["in_app", "email"] },
    { key: "document.reviewed", label: "HR verified or sent back a document you uploaded", defaults: ["in_app", "email"] },
    { key: "document.review", label: "Someone uploaded a document for you to check (HR)", defaults: ["in_app"] },
    { key: "document.expiry", label: "A document is about to expire (you and HR)", defaults: ["in_app", "email"] },
    { key: "esign.completed", label: "Everyone signed a letter you sent with erp Sign", defaults: ["in_app", "email"] },
    { key: "esign.declined", label: "A signer declined a letter you sent with erp Sign", defaults: ["in_app", "email"] },
  ] },
  { group: "Pay and expenses", events: [
    { key: "payroll.payslip", label: "Your payslip is ready", defaults: ["in_app", "email"] },
    { key: "payroll.paid", label: "Your salary was paid", defaults: ["in_app"] },
    { key: "salary.updated", label: "Your salary was revised", defaults: ["in_app", "email"] },
    { key: "bank.updated", label: "Your bank details were changed", defaults: ["in_app", "email"] },
    { key: "expense.scheduled", label: "An expense claim will be paid with your salary", defaults: ["in_app"] },
    { key: "expense.paid", label: "An expense claim or advance was paid", defaults: ["in_app", "email"] },
    { key: "loan.disbursed", label: "A loan was paid out", defaults: ["in_app", "email"] },
    { key: "tax.proof", label: "A tax proof was reviewed", defaults: ["in_app", "email"] },
  ] },
  { group: "Exits and helpdesk", events: [
    { key: "exit.started", label: "An exit was started for you", defaults: ["in_app", "email"] },
    { key: "exit.updated", label: "Your exit was updated or completed", defaults: ["in_app", "email"] },
    { key: "exit.survey", label: "The exit survey (sent when your exit starts)", defaults: ["in_app", "email"] },
    { key: "helpdesk.reply", label: "A reply on your helpdesk ticket", defaults: ["in_app", "email"] },
    { key: "helpdesk.closed", label: "Your helpdesk ticket was closed", defaults: ["in_app"] },
    { key: "helpdesk.assigned", label: "A ticket was assigned to you (agents)", defaults: ["in_app", "email"] },
    { key: "helpdesk.sla_breach", label: "A ticket breached its SLA (agents)", defaults: ["in_app", "email"] },
  ] },
];

export const ALL_EVENT_KEYS = NOTIFICATION_EVENTS.flatMap((g) => g.events.map((e) => e.key));
const BY_KEY = new Map(NOTIFICATION_EVENTS.flatMap((g) => g.events.map((e) => [e.key, e] as const)));

/** The catalog entry for a kind. Kinds not listed (helpdesk.note, loan.skip …) get in-app only, so nothing surprising goes out by email. */
export function eventFor(kind: string): NotificationEvent {
  return BY_KEY.get(kind) ?? { key: kind, label: kind, defaults: ["in_app"] };
}

/** Channels in force: a stored row wins over the default; an email-only event never gains in-app. */
export function channelsFor(kind: string, stored: Channel[] | null | undefined): Channel[] {
  const ev = eventFor(kind);
  const ch = stored ?? ev.defaults;
  return ch.filter((c): c is Channel => c === "in_app" || c === "email").filter((c) => !(ev.emailOnly && c === "in_app"));
}

export function validateChannels(kind: string, channels: unknown): Channel[] | null {
  if (!Array.isArray(channels) || channels.some((c) => c !== "in_app" && c !== "email")) return null;
  if (!BY_KEY.has(kind)) return null;
  return [...new Set(channels as Channel[])];
}
