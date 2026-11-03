/**
 * Hiring rules: stage groups, job / requisition / offer states, reapply cooldown, duplicate keys, scorecards and averages,
 * interview slots, analytics, templates and placeholders, resume text parsing, calendar files. Pure (no I/O).
 */

// ---------- labels ----------
export const STAGE_GROUPS = [
  { value: "sourced", label: "Sourced" },
  { value: "screening", label: "Screening" },
  { value: "interview", label: "Interview" },
  { value: "offer", label: "Offer" },
  { value: "hired", label: "Hired" },
  { value: "rejected", label: "Rejected" },
] as const;
export type StageGroup = (typeof STAGE_GROUPS)[number]["value"];
export const GROUP_ORDER: Record<StageGroup, number> = { sourced: 0, screening: 1, interview: 2, offer: 3, hired: 4, rejected: 5 };
export const groupLabel = (g: string) => STAGE_GROUPS.find((x) => x.value === g)?.label ?? g;

export const JOB_TYPES = [
  { value: "full_time", label: "Full time" },
  { value: "part_time", label: "Part time" },
  { value: "contract", label: "Contract" },
  { value: "intern", label: "Internship" },
] as const;
export type JobType = (typeof JOB_TYPES)[number]["value"];
export const jobTypeLabel = (t: string) => JOB_TYPES.find((x) => x.value === t)?.label ?? t;

export const SOURCES = [
  { value: "manual", label: "Added by recruiter" },
  { value: "career_site", label: "Careers page" },
  { value: "referral", label: "Employee referral" },
  { value: "internal", label: "Internal applicant" },
  { value: "import", label: "Imported" },
  { value: "job_board", label: "Job board" },
  { value: "agency", label: "Agency" },
] as const;
export type Source = (typeof SOURCES)[number]["value"];
export const sourceLabel = (s: string) => SOURCES.find((x) => x.value === s)?.label ?? s;

export const TEAM_ROLES = [
  { value: "recruiter", label: "Recruiter" },
  { value: "hiring_manager", label: "Hiring manager" },
  { value: "coordinator", label: "Coordinator" },
  { value: "panelist", label: "Interview panel" },
] as const;
export type TeamRole = (typeof TEAM_ROLES)[number]["value"];
/** Roles that may change a candidate's progress (move, reject, schedule, email, offers). Panelists only view, note and score. */
export const ACTING_ROLES: TeamRole[] = ["recruiter", "hiring_manager", "coordinator"];

export const JOB_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "open", label: "Open" },
  { value: "on_hold", label: "On hold" },
  { value: "closed", label: "Closed" },
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number]["value"];

export const REQ_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "pending", label: "Waiting for approval" },
  { value: "sent_back", label: "Sent back" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Declined" },
  { value: "converted", label: "Job created" },
  { value: "closed", label: "Closed" },
] as const;
export type ReqStatus = (typeof REQ_STATUSES)[number]["value"];

export const OFFER_STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "pending_approval", label: "Waiting for approval" },
  { value: "released", label: "Sent to candidate" },
  { value: "accepted", label: "Accepted" },
  { value: "declined", label: "Declined" },
  { value: "revised", label: "Replaced by a newer version" },
  { value: "withdrawn", label: "Withdrawn" },
  { value: "expired", label: "Expired" },
] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number]["value"];
export const offerStatusLabel = (s: string) => OFFER_STATUSES.find((x) => x.value === s)?.label ?? s;

export const RECOMMENDATIONS = [
  { value: "strong_yes", label: "Strong hire" },
  { value: "yes", label: "Hire" },
  { value: "no", label: "No hire" },
  { value: "strong_no", label: "Strong no hire" },
] as const;
export type Recommendation = (typeof RECOMMENDATIONS)[number]["value"];

export const REJECT_REASONS = [
  "Not enough experience", "Skills don't match", "Salary expectations too high", "Not interested any more",
  "Didn't show up", "Position filled", "Failed the interview", "Other",
] as const;

// ---------- state machines ----------
export type OfferAction = "submit" | "approve" | "reject_approval" | "release" | "accept" | "decline" | "revise" | "withdraw" | "expire";
const OFFER_FLOW: Record<OfferAction, { from: OfferStatus[]; to: OfferStatus }> = {
  submit: { from: ["draft"], to: "pending_approval" },
  approve: { from: ["pending_approval"], to: "draft" },          // approved: back with the recruiter, ready to release
  reject_approval: { from: ["pending_approval"], to: "draft" },
  release: { from: ["draft"], to: "released" },
  accept: { from: ["released"], to: "accepted" },
  decline: { from: ["released"], to: "declined" },
  revise: { from: ["draft", "pending_approval", "released"], to: "revised" },
  withdraw: { from: ["draft", "pending_approval", "released"], to: "withdrawn" },
  expire: { from: ["released"], to: "expired" },
};
/** Next status for an offer action, or null when it isn't allowed from this status. */
export function offerNext(status: string, action: OfferAction): OfferStatus | null {
  const t = OFFER_FLOW[action];
  return t.from.includes(status as OfferStatus) ? t.to : null;
}

export type ReqAction = "submit" | "edit" | "approve" | "reject" | "convert" | "close" | "withdraw";
const REQ_FLOW: Record<ReqAction, ReqStatus[]> = {
  submit: ["draft", "sent_back"],
  edit: ["draft", "sent_back"],
  approve: ["pending"],
  reject: ["pending"],
  convert: ["approved"],
  close: ["draft", "sent_back", "approved", "pending", "rejected"],
  withdraw: ["pending"],
};
export const reqCan = (status: string, action: ReqAction) => REQ_FLOW[action].includes(status as ReqStatus);

export type JobAction = "publish" | "hold" | "reopen" | "close" | "edit";
const JOB_FLOW: Record<JobAction, { from: JobStatus[]; to: JobStatus }> = {
  publish: { from: ["draft"], to: "open" },
  hold: { from: ["open"], to: "on_hold" },
  reopen: { from: ["on_hold", "closed"], to: "open" },
  close: { from: ["draft", "open", "on_hold"], to: "closed" },
  edit: { from: ["draft", "open", "on_hold"], to: "draft" },   // `to` unused for edit
};
export function jobNext(status: string, action: JobAction): JobStatus | null {
  const t = JOB_FLOW[action];
  return t.from.includes(status as JobStatus) ? (action === "edit" ? (status as JobStatus) : t.to) : null;
}

/**
 * May a candidate be moved into this stage group by hand? Rejection has its own action (it needs a reason) and
 * "hired" only comes from converting an accepted offer, so both are refused here. Closed applications can't move.
 */
export function moveProblem(appStatus: string, toGroup: string): string | null {
  if (appStatus !== "active") return "This candidate is no longer active on the job. Restore them first.";
  if (toGroup === "rejected") return "Use Reject to move someone out of the process, so a reason is recorded.";
  if (toGroup === "hired") return "Candidates move to Hired when their accepted offer is converted to an employee.";
  return null;
}

// ---------- duplicates and reapplying ----------
export const normalizeEmail = (e: string) => e.trim().toLowerCase();
export const isEmail = (e: string) => /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i.test(e.trim()) && e.trim().length <= 254;
/** Digits only, Indian numbers without the +91 / leading 0, so "+91 98450-12345" and "098450 12345" match. */
export function normalizePhone(p: string | null | undefined) {
  if (!p) return null;
  let d = p.replace(/\D/g, "");
  if (d.length === 12 && d.startsWith("91")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return d.length >= 7 && d.length <= 15 ? d : null;
}

/**
 * Can someone apply again to a job they were already in? Active (or hired) applications block; a closed one
 * (rejected / withdrawn) only after the job's cooldown in days. No cooldown set (null) = never again for this job.
 */
export function reapplyCheck(prev: { status: string; closedAt: Date | null } | null, cooldownDays: number | null, now: Date):
  { ok: true; reopen: boolean } | { ok: false; reason: "active" | "hired" | "cooldown" | "no_reapply"; until?: Date } {
  if (!prev) return { ok: true, reopen: false };
  if (prev.status === "active") return { ok: false, reason: "active" };
  if (prev.status === "hired") return { ok: false, reason: "hired" };
  if (cooldownDays == null) return { ok: false, reason: "no_reapply" };
  const until = new Date((prev.closedAt ?? now).getTime() + cooldownDays * 864e5);
  return until <= now ? { ok: true, reopen: true } : { ok: false, reason: "cooldown", until };
}

export function splitName(full: string): { first: string; last: string | null } {
  const parts = full.trim().replace(/\s+/g, " ").split(" ").filter(Boolean);
  if (!parts.length) return { first: "", last: null };
  return { first: parts[0], last: parts.slice(1).join(" ") || null };
}

// ---------- scorecards ----------
export type ScalePoint = { value: number; label: string };
export type Section = { title: string; criteria: { id: string; label: string }[] };

export function validateScale(points: ScalePoint[]): string | null {
  if (points.length < 2 || points.length > 10) return "A scale needs 2 to 10 points.";
  const values = points.map((p) => p.value);
  if (values.some((v) => !Number.isInteger(v) || v < 0 || v > 10)) return "Point values are whole numbers from 0 to 10.";
  if (new Set(values).size !== values.length) return "Each point needs its own value.";
  if (points.some((p) => !p.label.trim() || p.label.length > 40)) return "Give every point a short label.";
  return null;
}

export function validateSections(sections: Section[]): string | null {
  if (!sections.length || sections.length > 12) return "Add between 1 and 12 sections.";
  const ids = new Set<string>();
  for (const s of sections) {
    if (!s.title.trim() || s.title.length > 80) return "Every section needs a title.";
    if (!s.criteria.length || s.criteria.length > 15) return `"${s.title}" needs between 1 and 15 criteria.`;
    for (const c of s.criteria) {
      if (!c.label.trim() || c.label.length > 120) return `Every criterion in "${s.title}" needs a label.`;
      if (!/^[a-z0-9_-]{1,40}$/i.test(c.id) || ids.has(c.id)) return "Criteria ids must be unique.";
      ids.add(c.id);
    }
  }
  return null;
}

/**
 * Checks a scorecard submission: every criterion rated with a value on the scale, a recommendation, and an overall
 * rating when the card asks for one. Returns the overall score (the given overall, or the mean of the criteria).
 */
export function scoreSubmission(card: { sections: Section[]; points: ScalePoint[]; overallRating: boolean },
  input: { ratings: Record<string, number>; overall: number | null; recommendation: string | null }):
  { ok: true; overall: number; ratings: Record<string, number> } | { ok: false; error: string } {
  const allowed = new Set(card.points.map((p) => p.value));
  const ratings: Record<string, number> = {};
  for (const s of card.sections) for (const c of s.criteria) {
    const v = input.ratings[c.id];
    if (v == null) return { ok: false, error: `Rate "${c.label}".` };
    if (!allowed.has(v)) return { ok: false, error: `Pick a rating on the scale for "${c.label}".` };
    ratings[c.id] = v;
  }
  if (!RECOMMENDATIONS.some((r) => r.value === input.recommendation)) return { ok: false, error: "Pick your recommendation." };
  if (card.overallRating) {
    if (input.overall == null || !allowed.has(input.overall)) return { ok: false, error: "Give an overall rating." };
    return { ok: true, overall: input.overall, ratings };
  }
  const vals = Object.values(ratings);
  return { ok: true, overall: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100, ratings };
}

/** Mean of the submitted overall scores, rounded to 1 decimal; null with none. */
export function average(scores: (number | null | undefined)[]): number | null {
  const xs = scores.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  if (!xs.length) return null;
  return Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
}

/** Per-criterion means across submissions (for the feedback tab). */
export function criterionAverages(subs: Record<string, number>[]): Record<string, number> {
  const sum: Record<string, { t: number; n: number }> = {};
  for (const s of subs) for (const [k, v] of Object.entries(s)) { (sum[k] ??= { t: 0, n: 0 }).t += v; sum[k].n++; }
  return Object.fromEntries(Object.entries(sum).map(([k, { t, n }]) => [k, Math.round((t / n) * 10) / 10]));
}

// ---------- interview slots ----------
export type Slot = { start: Date; end: Date };
export const overlaps = (a: Slot, b: Slot) => a.start < b.end && b.start < a.end;

/** Slots offered for self-scheduling: 1–10, each in the future, 15 min – 8 h long, not overlapping each other. */
export function validateSlots(slots: Slot[], now: Date): string | null {
  if (!slots.length) return "Offer at least one time slot.";
  if (slots.length > 10) return "Offer at most 10 time slots.";
  for (const s of slots) {
    if (Number.isNaN(s.start.getTime()) || Number.isNaN(s.end.getTime())) return "One of the slots isn't a valid time.";
    if (s.start <= now) return "Slots must be in the future.";
    const mins = (s.end.getTime() - s.start.getTime()) / 60000;
    if (mins < 15 || mins > 480) return "Each slot must be between 15 minutes and 8 hours long.";
  }
  const sorted = [...slots].sort((a, b) => a.start.getTime() - b.start.getTime());
  for (let i = 1; i < sorted.length; i++) if (overlaps(sorted[i - 1], sorted[i])) return "Two of the slots overlap.";
  return null;
}

export function validateInterviewTime(start: Date, end: Date, now: Date): string | null {
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "Pick a date and time.";
  if (end <= start) return "The interview must end after it starts.";
  if ((end.getTime() - start.getTime()) / 60000 > 480) return "Interviews can be at most 8 hours long.";
  if (start.getTime() < now.getTime() - 7 * 864e5) return "That date is too far in the past.";
  return null;
}

/** "Mon, 3 Nov, 10:30 am – 11:30 am" in IST. */
export function slotLabel(s: Slot) {
  const day = s.start.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
  const t = (d: Date) => d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
  return `${day}, ${t(s.start)} – ${t(s.end)} IST`;
}

/** A calendar file (RFC 5545) for one interview. */
export function icsFor(a: { uid: string; start: Date; end: Date; title: string; description: string; location: string | null; now: Date }) {
  const f = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//erp//hire//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT", `UID:${a.uid}@erp`, `DTSTAMP:${f(a.now)}`, `DTSTART:${f(a.start)}`, `DTEND:${f(a.end)}`,
    `SUMMARY:${esc(a.title)}`, `DESCRIPTION:${esc(a.description)}`, ...(a.location ? [`LOCATION:${esc(a.location)}`] : []),
    "END:VEVENT", "END:VCALENDAR", "",
  ].join("\r\n");
}

export function safeMeetingUrl(u: string | null | undefined): string | null {
  if (!u?.trim()) return null;
  try {
    const url = new URL(u.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString().slice(0, 500) : null;
  } catch { return null; }
}

// ---------- analytics ----------
export type FunnelApp = { furthest: StageGroup; status: string; source: string; createdAt: Date; hiredAt: Date | null };

/** How many applications reached each stage group (a hire counts for every group before it). */
export function funnel(apps: FunnelApp[]) {
  const order: StageGroup[] = ["sourced", "screening", "interview", "offer", "hired"];
  const reached = order.map((g) => ({ group: g, label: groupLabel(g), count: apps.filter((a) => GROUP_ORDER[a.furthest] >= GROUP_ORDER[g] && a.furthest !== "rejected").length }));
  // rejected applications reached the group they were in before rejection: callers pass that as `furthest`
  return reached.map((r, i) => ({ ...r, conversion: i === 0 || !reached[i - 1].count ? null : Math.round((r.count / reached[i - 1].count) * 100) }));
}

export function bySource(apps: FunnelApp[]) {
  const m = new Map<string, { source: string; label: string; applied: number; hired: number }>();
  for (const a of apps) {
    const r = m.get(a.source) ?? { source: a.source, label: sourceLabel(a.source), applied: 0, hired: 0 };
    r.applied++; if (a.status === "hired") r.hired++;
    m.set(a.source, r);
  }
  return [...m.values()].sort((a, b) => b.applied - a.applied);
}

/** Average and median whole days from application to hire. */
export function timeToHire(apps: FunnelApp[]) {
  const days = apps.filter((a) => a.hiredAt).map((a) => Math.max(0, Math.round((a.hiredAt!.getTime() - a.createdAt.getTime()) / 864e5))).sort((a, b) => a - b);
  if (!days.length) return { average: null, median: null, hires: 0 };
  const mid = Math.floor(days.length / 2);
  return { average: Math.round(days.reduce((a, b) => a + b, 0) / days.length), median: days.length % 2 ? days[mid] : Math.round((days[mid - 1] + days[mid]) / 2), hires: days.length };
}

export function acceptanceRate(offers: { status: string }[]) {
  const accepted = offers.filter((o) => o.status === "accepted").length;
  const declined = offers.filter((o) => o.status === "declined" || o.status === "expired").length;
  return { accepted, declined, rate: accepted + declined ? Math.round((accepted / (accepted + declined)) * 100) : null };
}

// ---------- rate limiting ----------
/** Start of the fixed window containing `now`. */
export function windowStart(now: Date, minutes: number) {
  const ms = minutes * 60_000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

// ---------- text, templates and placeholders ----------
const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Plain text → paragraphs (blank line) and line breaks, escaped. */
export function textToHtml(text: string) {
  return text.trim().split(/\n{2,}/).map((p) => `<p>${escHtml(p.trim()).replace(/\n/g, "<br>")}</p>`).join("");
}
export function htmlToText(html: string) {
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|h2|h3|li)>/gi, "\n").replace(/<li>/gi, "• ").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n").trim();
}

export const OFFER_PLACEHOLDERS = [
  { key: "candidate.name", label: "Candidate's full name", sample: "Neha Gupta" },
  { key: "candidate.first_name", label: "Candidate's first name", sample: "Neha" },
  { key: "job.title", label: "Job title", sample: "Backend Engineer" },
  { key: "offer.designation", label: "Designation", sample: "Software Engineer" },
  { key: "offer.department", label: "Department", sample: "Engineering" },
  { key: "offer.location", label: "Location", sample: "Bengaluru" },
  { key: "offer.ctc", label: "Annual CTC", sample: "₹18,00,000" },
  { key: "offer.joining_date", label: "Joining date", sample: "1 December 2026" },
  { key: "offer.expires_on", label: "Accept by", sample: "15 November 2026" },
  { key: "company.name", label: "Company name", sample: "Your Company" },
  { key: "today", label: "Today's date", sample: "3 November 2026" },
] as const;

export const EMAIL_PLACEHOLDERS = [
  { key: "candidate.first_name", label: "Candidate's first name" },
  { key: "candidate.name", label: "Candidate's full name" },
  { key: "job.title", label: "Job title" },
  { key: "company.name", label: "Company name" },
  { key: "interview.when", label: "Interview date and time" },
  { key: "interview.mode", label: "Interview mode" },
  { key: "interview.link", label: "Meeting link or venue" },
  { key: "link", label: "Link for the candidate (portal or scheduling page)" },
] as const;

const TOKEN = /\{\{\s*([a-z_.]+)\s*\}\}/g;
export const placeholdersIn = (s: string) => [...new Set([...s.matchAll(TOKEN)].map((m) => m[1]))];
export function unknownIn(s: string, known: readonly { key: string }[]) {
  const k = new Set(known.map((x) => x.key));
  return placeholdersIn(s).filter((p) => !k.has(p));
}
/** Plain-text merge for email subjects and bodies. Missing values become empty. */
export function mergeText(s: string, values: Record<string, string | null | undefined>) {
  return s.replace(TOKEN, (_, k: string) => values[k] ?? "");
}

export const EMAIL_TEMPLATE_KEYS = [
  { key: "application_received", label: "Application received" },
  { key: "interview_scheduled", label: "Interview scheduled" },
  { key: "self_schedule", label: "Pick an interview slot" },
  { key: "rejection", label: "Not moving forward" },
  { key: "offer_released", label: "Offer sent" },
  { key: "stage_update", label: "Moving to the next round" },
] as const;

export const DEFAULT_EMAIL_TEMPLATES: { key: string; subject: string; body: string }[] = [
  { key: "application_received", subject: "We received your application for {{job.title}}",
    body: "Hi {{candidate.first_name}},\n\nThank you for applying for {{job.title}} at {{company.name}}. Our team will look at your profile and get back to you within a couple of weeks.\n\nRegards,\nHiring team, {{company.name}}" },
  { key: "interview_scheduled", subject: "Interview for {{job.title}} on {{interview.when}}",
    body: "Hi {{candidate.first_name}},\n\nYour interview for {{job.title}} is set for {{interview.when}} ({{interview.mode}}).\n\nWhere: {{interview.link}}\n\nIf this time doesn't work, reply to this email and we'll find another.\n\nRegards,\nHiring team, {{company.name}}" },
  { key: "self_schedule", subject: "Pick a time for your {{job.title}} interview",
    body: "Hi {{candidate.first_name}},\n\nWe'd like to talk to you about {{job.title}}. Choose a time that suits you here:\n{{link}}\n\nRegards,\nHiring team, {{company.name}}" },
  { key: "rejection", subject: "Your application for {{job.title}}",
    body: "Hi {{candidate.first_name}},\n\nThank you for your time and interest in {{job.title}} at {{company.name}}. After careful thought we've decided not to take your application further.\n\nWe'll keep your details and reach out if a better match opens up.\n\nRegards,\nHiring team, {{company.name}}" },
  { key: "offer_released", subject: "Your offer from {{company.name}}",
    body: "Hi {{candidate.first_name}},\n\nWe're happy to offer you the role of {{job.title}}. You can read the offer, accept it and share your joining documents here:\n{{link}}\n\nRegards,\nHiring team, {{company.name}}" },
  { key: "stage_update", subject: "Next steps for {{job.title}}",
    body: "Hi {{candidate.first_name}},\n\nGood news: you're moving to the next round for {{job.title}}. We'll be in touch shortly with details.\n\nRegards,\nHiring team, {{company.name}}" },
];

export const DEFAULT_FLOW: { name: string; group: StageGroup }[] = [
  { name: "New", group: "sourced" },
  { name: "Screening", group: "screening" },
  { name: "Technical round", group: "interview" },
  { name: "Manager round", group: "interview" },
  { name: "Offer", group: "offer" },
  { name: "Hired", group: "hired" },
  { name: "Not selected", group: "rejected" },
];

/** A flow must start somewhere, end in Hired, and have a place for rejected candidates. */
export function validateFlow(stages: { name: string; group: string }[]): string | null {
  if (stages.length < 3 || stages.length > 20) return "A hiring flow needs between 3 and 20 stages.";
  if (stages.some((s) => !s.name.trim() || s.name.trim().length > 60)) return "Every stage needs a name (up to 60 characters).";
  if (new Set(stages.map((s) => s.name.trim().toLowerCase())).size !== stages.length) return "Stage names must be different.";
  if (stages.some((s) => !(s.group in GROUP_ORDER))) return "Pick a group for every stage.";
  if (stages.filter((s) => s.group === "hired").length !== 1) return "Have exactly one Hired stage.";
  if (stages.filter((s) => s.group === "rejected").length !== 1) return "Have exactly one stage for rejected candidates.";
  if (!stages.some((s) => s.group !== "hired" && s.group !== "rejected")) return "Add at least one stage before Hired.";
  for (let i = 1; i < stages.length; i++) {
    const a = stages[i - 1].group as StageGroup, b = stages[i].group as StageGroup;
    if (GROUP_ORDER[b] < GROUP_ORDER[a]) return `"${stages[i].name}" is out of order: stages run Sourced → Screening → Interview → Offer → Hired → Rejected.`;
  }
  return null;
}

export const DEFAULT_SCALE: ScalePoint[] = [
  { value: 1, label: "Poor" }, { value: 2, label: "Below the bar" }, { value: 3, label: "Meets the bar" }, { value: 4, label: "Strong" }, { value: 5, label: "Outstanding" },
];

export const DEFAULT_SCORECARD: Section[] = [
  { title: "Skills", criteria: [{ id: "problem_solving", label: "Problem solving" }, { id: "domain", label: "Knowledge of the domain" }] },
  { title: "Working together", criteria: [{ id: "communication", label: "Communication" }, { id: "ownership", label: "Ownership" }] },
];

export const DEFAULT_JD_TEMPLATES: { name: string; text: string }[] = [
  { name: "Software engineer", text: "About the role\nYou'll build and run the services our customers use every day, working closely with product and design.\n\nWhat you'll do\n- Design, build and test features end to end\n- Review code and help teammates grow\n- Keep our systems fast, secure and reliable\n\nWhat we're looking for\n- Solid experience with at least one backend language\n- Comfort with SQL databases\n- Clear written communication" },
  { name: "Sales executive", text: "About the role\nYou'll own a territory and help new customers understand how we can help them.\n\nWhat you'll do\n- Qualify leads and run product demos\n- Build a healthy pipeline and close deals\n- Share customer feedback with the product team\n\nWhat we're looking for\n- Experience in B2B sales\n- Strong conversation and negotiation skills\n- Willingness to travel within the region" },
];

export const DEFAULT_OFFER_TEMPLATE = {
  name: "Offer letter",
  body: `<p>{{today}}</p><p><strong>{{candidate.name}}</strong></p><h2>Offer of employment</h2>` +
    `<p>Dear {{candidate.first_name}},</p>` +
    `<p>We are pleased to offer you the position of <strong>{{offer.designation}}</strong> in the {{offer.department}} team at {{company.name}}, based in {{offer.location}}.</p>` +
    `<p>Your annual cost to company will be <strong>{{offer.ctc}}</strong>. The detailed salary structure is shared with you separately.</p>` +
    `<p>We would like you to join us on <strong>{{offer.joining_date}}</strong>. Please accept this offer by {{offer.expires_on}}.</p>` +
    `<p>This offer depends on satisfactory verification of your documents and references.</p>` +
    `<p>We look forward to working with you.</p><p>For {{company.name}}</p><p><strong>People team</strong></p>`,
};

export const DEFAULT_PREBOARDING_DOCS = ["PAN card", "Aadhaar card", "Latest payslip or offer letter", "Highest degree certificate", "Passport-size photo"];
export const DEFAULT_PREBOARDING_TASKS = ["Fill in your personal details", "Read the employee handbook", "Share your bank details for salary"];

// ---------- resume parsing (from extracted text) ----------
const SKILLS = ["java", "python", "javascript", "typescript", "react", "node.js", "go", "golang", "rust", "c++", "c#", "sql", "postgresql", "mysql", "mongodb",
  "aws", "azure", "gcp", "docker", "kubernetes", "terraform", "kotlin", "swift", "android", "ios", "flutter", "django", "spring", "next.js",
  "salesforce", "excel", "tally", "sap", "figma", "photoshop", "seo", "marketing", "b2b sales", "negotiation", "accounting", "gst", "payroll", "recruitment"];

export type Parsed = { email: string | null; phone: string | null; name: string | null; experienceYears: number | null; skills: string[]; linkedin: string | null };

/** Pulls likely contact details, years of experience and known skills out of resume text. Best effort. */
export function parseResumeText(text: string): Parsed {
  const t = text.replace(/\u0000/g, " ");
  const email = t.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0]?.toLowerCase() ?? null;
  const phoneRaw = t.match(/(?:\+?91[\s-]?)?(?:0)?[6-9]\d{4}[\s-]?\d{5}\b/)?.[0] ?? null;
  const exp = t.match(/(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:years|yrs|year)\b/i);
  const lower = t.toLowerCase();
  const skills = SKILLS.filter((s) => new RegExp(`(^|[^a-z0-9])${s.replace(/[.+#]/g, (c) => "\\" + c)}($|[^a-z0-9])`, "i").test(lower));
  const linkedin = t.match(/(?:https?:\/\/)?(?:www\.)?linkedin\.com\/in\/[A-Za-z0-9_-]+/i)?.[0] ?? null;
  const name = t.split(/\r?\n/).map((l) => l.trim()).find((l) => /^[A-Za-z][A-Za-z.' -]{2,40}$/.test(l) && l.split(" ").length >= 2 && l.split(" ").length <= 4 && !/resume|curriculum|vitae|profile/i.test(l)) ?? null;
  const years = exp ? Number(exp[1]) : null;
  return { email, phone: normalizePhone(phoneRaw), name, experienceYears: years != null && years <= 50 ? years : null, skills, linkedin };
}

/** Text from one PDF content stream: strings shown with Tj / TJ / ' / " (literal or hex). Lines break on Td, TD, T-star and ET. */
export function pdfStreamText(stream: string): string {
  const out: string[] = [];
  const unescape = (s: string) => s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c: string) => {
    if (/^[0-7]+$/.test(c)) return String.fromCharCode(parseInt(c, 8));
    return ({ n: "\n", r: "\r", t: "\t", b: "", f: "", "(": "(", ")": ")", "\\": "\\" } as Record<string, string>)[c] ?? c;
  });
  const hex = (h: string) => {
    const d = h.replace(/[^0-9a-f]/gi, "");
    let r = "";
    for (let i = 0; i < d.length; i += 2) r += String.fromCharCode(parseInt(d.slice(i, i + 2).padEnd(2, "0"), 16));
    return r;
  };
  const str = (p: string) => (p.startsWith("(") ? unescape(p.slice(1, -1)) : hex(p.slice(1, -1)));
  const re = /(\((?:\\.|[^\\)])*\)|<[0-9a-fA-F\s]*>)\s*(?:Tj|'|")|\[((?:\\.|[^\]])*)\]\s*TJ|T\*|Td|TD|ET/g;
  for (const m of stream.matchAll(re)) {
    const tok = m[0];
    if (tok === "T*" || tok === "ET" || tok === "Td" || tok === "TD") { out.push("\n"); continue; }
    if (tok.startsWith("[")) {
      for (const part of (m[2] ?? "").matchAll(/\((?:\\.|[^\\)])*\)|<[0-9a-fA-F\s]*>|-?\d+(?:\.\d+)?/g)) {
        const p = part[0];
        if (p.startsWith("(") || p.startsWith("<")) out.push(str(p));
        else if (Number(p) < -200) out.push(" ");
      }
      continue;
    }
    if (m[1]) out.push(str(m[1]));
  }
  return out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

// ---------- import ----------
export const IMPORT_COLUMNS = [
  { key: "firstName", header: "First name", required: true, width: 16, example: "Neha" },
  { key: "lastName", header: "Last name", required: false, width: 16, example: "Gupta" },
  { key: "email", header: "Email", required: true, width: 28, example: "neha.gupta@example.com" },
  { key: "mobile", header: "Mobile", required: false, width: 16, example: "9845012345" },
  { key: "currentCompany", header: "Current company", required: false, width: 22, example: "Globex" },
  { key: "currentTitle", header: "Current title", required: false, width: 22, example: "Senior Engineer" },
  { key: "experienceYears", header: "Experience (years)", required: false, width: 14, example: "5" },
  { key: "tags", header: "Tags (comma separated)", required: false, width: 26, example: "backend, java" },
] as const;
export const MAX_IMPORT_ROWS = 1000;

export type ImportRow = { row: number; firstName: string; lastName: string | null; email: string; mobile: string | null; currentCompany: string | null; currentTitle: string | null; experienceMonths: number | null; tags: string[] };

/** Validates imported rows: required fields, email format, duplicates inside the file. */
export function validateImportRows(raw: { row: number; values: Record<string, string> }[]): { rows: ImportRow[]; errors: { row: number; error: string }[] } {
  const rows: ImportRow[] = [], errors: { row: number; error: string }[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const v = (k: string) => (r.values[k] ?? "").toString().trim();
    if (Object.values(r.values).every((x) => !String(x ?? "").trim())) continue;
    const first = v("firstName"), email = normalizeEmail(v("email"));
    if (!first) { errors.push({ row: r.row, error: "First name is missing." }); continue; }
    if (!isEmail(email)) { errors.push({ row: r.row, error: "Email is missing or not valid." }); continue; }
    if (seen.has(email)) { errors.push({ row: r.row, error: "This email appears twice in the file." }); continue; }
    const expRaw = v("experienceYears");
    const exp = expRaw === "" ? null : Number(expRaw);
    if (exp != null && (!Number.isFinite(exp) || exp < 0 || exp > 50)) { errors.push({ row: r.row, error: "Experience must be a number of years from 0 to 50." }); continue; }
    seen.add(email);
    rows.push({
      row: r.row, firstName: first.slice(0, 80), lastName: v("lastName").slice(0, 80) || null, email, mobile: v("mobile").slice(0, 20) || null,
      currentCompany: v("currentCompany").slice(0, 120) || null, currentTitle: v("currentTitle").slice(0, 120) || null,
      experienceMonths: exp == null ? null : Math.round(exp * 12), tags: cleanTags(v("tags").split(",")),
    });
  }
  return { rows, errors };
}

export function cleanTags(tags: string[]) {
  return [...new Set(tags.map((t) => t.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 30)).filter(Boolean))].slice(0, 15);
}

/** "5 yrs 3 mos" from months. */
export function experienceLabel(months: number | null | undefined) {
  if (months == null) return null;
  const y = Math.floor(months / 12), m = months % 12;
  if (!y && !m) return "Fresher";
  return [y ? `${y} yr${y > 1 ? "s" : ""}` : "", m ? `${m} mo${m > 1 ? "s" : ""}` : ""].filter(Boolean).join(" ");
}
