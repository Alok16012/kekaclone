/**
 * Engage (Home wall) rules: pure, no I/O, shared by the service, the composer UI and the tests.
 * Validators return a problem ({ message, field }) or null, so callers decide how to surface it.
 */
import { addDaysISO, type ISODate } from "@/lib/dates";
import { nextOccurrence } from "@/server/modules/org/dates";

export const POST_KINDS = ["post", "announcement", "poll", "praise"] as const;
export type PostKind = (typeof POST_KINDS)[number];

export const REACTIONS = ["like", "celebrate", "love", "insightful"] as const;
export type Reaction = (typeof REACTIONS)[number];

export const LIMITS = {
  body: 3000, title: 150, question: 300, comment: 1000, praise: 1000,
  pollOptionsMin: 2, pollOptionsMax: 10, optionLabel: 120,
  recipients: 10, audienceIds: 50, images: 4,
  imageBytes: 5 * 1024 * 1024,
  pageSize: 10,
} as const;

export const IMAGE_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export type ImageMime = (typeof IMAGE_MIME)[number];
export const IMAGE_EXT: Record<ImageMime, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

/** The badge list a new company starts with (also used by the demo seed). */
export const DEFAULT_BADGES = [
  { name: "Team player", icon: "handshake" },
  { name: "Above and beyond", icon: "rocket" },
  { name: "Problem solver", icon: "lightbulb" },
  { name: "Customer hero", icon: "heart" },
  { name: "Great mentor", icon: "graduation-cap" },
  { name: "Star performer", icon: "star" },
] as const;

export type Audience = { type: "org" } | { type: "departments"; ids: string[] } | { type: "locations"; ids: string[] };

export type Problem = { message: string; field?: string };
const problem = (message: string, field?: string): Problem => ({ message, field });

export type DraftInput = {
  kind: PostKind;
  body?: string | null;
  title?: string | null;
  audience?: Audience;
  mediaFileIds?: string[];
  poll?: { options: string[]; multiple: boolean; anonymous: boolean; endsAt: string | null };
  praise?: { recipientIds: string[]; badgeId: string };
  /** announcements: pin until the end of this calendar day (IST) */
  pinnedUntil?: ISODate | null;
  /** announcements: go live at this moment instead of now (ISO timestamp) */
  publishAt?: string | null;
};

/** Trimmed text or null. */
export const clean = (s: string | null | undefined) => {
  const t = (s ?? "").trim();
  return t ? t : null;
};

/** Poll options: trimmed, blanks dropped. Duplicates are reported by validateDraft, not silently merged. */
export const cleanOptions = (opts: string[]) => opts.map((o) => o.trim()).filter(Boolean);

/** Shape and limits of a draft. `now` is passed in so the rule stays pure. Permission/ownership checks live in the service. */
export function validateDraft(d: DraftInput, ctx: { authorId: string; now: Date; today: ISODate }): Problem | null {
  const body = clean(d.body), title = clean(d.title);
  const a = d.audience ?? { type: "org" };
  if (a.type !== "org") {
    if (!a.ids.length) return problem(a.type === "departments" ? "Pick at least one department." : "Pick at least one location.", "audience");
    if (a.ids.length > LIMITS.audienceIds) return problem("That's too many groups for one post.", "audience");
  }
  if (d.kind !== "announcement" && a.type === "locations") return problem("Only announcements can be sent to locations.", "audience");
  if ((d.mediaFileIds?.length ?? 0) > LIMITS.images) return problem(`Add up to ${LIMITS.images} images.`, "media");
  if (d.kind !== "post" && d.kind !== "announcement" && d.mediaFileIds?.length) return problem("Images can only be added to posts and announcements.", "media");
  if (d.kind !== "announcement" && (d.pinnedUntil || d.publishAt)) return problem("Only announcements can be pinned or scheduled.");

  switch (d.kind) {
    case "post":
      if (!body && !d.mediaFileIds?.length) return problem("Write something or add an image.", "body");
      if (body && body.length > LIMITS.body) return problem(`Keep it under ${LIMITS.body} characters.`, "body");
      return null;
    case "announcement": {
      if (!title) return problem("Give the announcement a title.", "title");
      if (title.length > LIMITS.title) return problem(`Keep the title under ${LIMITS.title} characters.`, "title");
      if (!body) return problem("Add the announcement text.", "body");
      if (body.length > LIMITS.body) return problem(`Keep it under ${LIMITS.body} characters.`, "body");
      if (d.pinnedUntil) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d.pinnedUntil)) return problem("Pick a valid date to pin until.", "pinnedUntil");
        if (d.pinnedUntil < ctx.today) return problem("The pin date can't be in the past.", "pinnedUntil");
        if (d.pinnedUntil > addDaysISO(ctx.today, 366)) return problem("Pin for at most a year.", "pinnedUntil");
      }
      if (d.publishAt) {
        const t = Date.parse(d.publishAt);
        if (Number.isNaN(t)) return problem("Pick a valid date and time to publish.", "publishAt");
        if (t < ctx.now.getTime() - 5 * 60_000) return problem("The publish time has already passed.", "publishAt");
        if (t > ctx.now.getTime() + 366 * 864e5) return problem("Schedule at most a year ahead.", "publishAt");
      }
      return null;
    }
    case "poll": {
      if (!body) return problem("Ask a question.", "body");
      if (body.length > LIMITS.question) return problem(`Keep the question under ${LIMITS.question} characters.`, "body");
      const p = d.poll;
      if (!p) return problem("Add the poll options.", "options");
      const opts = cleanOptions(p.options);
      if (opts.length < LIMITS.pollOptionsMin) return problem("Add at least two options.", "options");
      if (opts.length > LIMITS.pollOptionsMax) return problem(`Add at most ${LIMITS.pollOptionsMax} options.`, "options");
      if (opts.some((o) => o.length > LIMITS.optionLabel)) return problem(`Keep each option under ${LIMITS.optionLabel} characters.`, "options");
      if (new Set(opts.map((o) => o.toLowerCase())).size !== opts.length) return problem("Two options are the same.", "options");
      if (p.endsAt) {
        const t = Date.parse(p.endsAt);
        if (Number.isNaN(t)) return problem("Pick a valid end date.", "endsAt");
        if (t <= ctx.now.getTime()) return problem("The end date has to be in the future.", "endsAt");
        if (t > ctx.now.getTime() + 366 * 864e5) return problem("A poll can run for at most a year.", "endsAt");
      }
      return null;
    }
    case "praise": {
      const pr = d.praise;
      if (!pr || !pr.recipientIds.length) return problem("Pick who you'd like to praise.", "recipients");
      if (new Set(pr.recipientIds).size !== pr.recipientIds.length) return problem("Someone is listed twice.", "recipients");
      if (pr.recipientIds.length > LIMITS.recipients) return problem(`Praise up to ${LIMITS.recipients} people at once.`, "recipients");
      if (pr.recipientIds.includes(ctx.authorId)) return problem("You can't praise yourself. Pick a colleague instead.", "recipients");
      if (!pr.badgeId) return problem("Pick a badge.", "badge");
      if (!body) return problem("Say what they did.", "body");
      if (body.length > LIMITS.praise) return problem(`Keep it under ${LIMITS.praise} characters.`, "body");
      return null;
    }
  }
}

/** Which options a vote may contain: known to this poll, no repeats, exactly one unless multiple choice. */
export function validateVote(optionIds: string[], poll: { multiple: boolean; optionIds: string[]; endsAt: string | null }, now: Date): Problem | null {
  if (poll.endsAt && Date.parse(poll.endsAt) <= now.getTime()) return problem("This poll has closed.");
  if (!optionIds.length) return problem("Pick an option.");
  if (new Set(optionIds).size !== optionIds.length) return problem("Each option counts once.");
  if (!poll.multiple && optionIds.length > 1) return problem("This poll takes one answer.");
  if (optionIds.some((id) => !poll.optionIds.includes(id))) return problem("That option isn't part of this poll.");
  return null;
}

/**
 * Share of votes per option as whole percentages that add up to exactly 100 (largest remainder),
 * so the bars never read 33 + 33 + 33 = 99.
 */
export function percentages(votes: number[]): number[] {
  const total = votes.reduce((a, b) => a + b, 0);
  if (total === 0) return votes.map(() => 0);
  const raw = votes.map((v) => (v * 100) / total);
  const floor = raw.map(Math.floor);
  let left = 100 - floor.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) { if (left <= 0) break; floor[i]++; left--; }
  return floor;
}

export type AnnouncementStatus = "scheduled" | "live" | "expired";
export function announcementStatus(publishAt: Date, expiresAt: Date | null, now: Date): AnnouncementStatus {
  if (publishAt.getTime() > now.getTime()) return "scheduled";
  if (expiresAt && expiresAt.getTime() <= now.getTime()) return "expired";
  return "live";
}

/** "Pin until 12 Nov" means through the end of 12 Nov in India. */
export function endOfDayIST(d: ISODate): Date {
  return new Date(`${d}T23:59:59.999+05:30`);
}

/** Feed cursor: the last item's exact publish time (UTC, microsecond precision, from Postgres) and id. Opaque to the client. */
export type Cursor = { at: string; id: string };
const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));
export function encodeCursor(c: Cursor): string {
  return b64url(JSON.stringify([c.at, c.id]));
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function decodeCursor(s: string | null | undefined): Cursor | null {
  if (!s || s.length > 200) return null;
  try {
    const v = JSON.parse(unb64url(s));
    if (!Array.isArray(v) || v.length !== 2 || typeof v[0] !== "string" || typeof v[1] !== "string") return null;
    if (!UUID.test(v[1]) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(v[0])) return null;
    return { at: v[0], id: v[1] };
  } catch {
    return null;
  }
}

/** Image type from the file's first bytes; the declared type and the extension aren't trusted. */
export function sniffImage(b: Uint8Array): ImageMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x)) return "image/png";
  if (b.length >= 6 && String.fromCharCode(...b.slice(0, 6)).match(/^GIF8[79]a$/)) return "image/gif";
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

export function checkImage(f: { size: number; declared: string; sniffed: ImageMime | null }): Problem | null {
  if (f.size === 0) return problem("That file is empty.", "media");
  if (f.size > LIMITS.imageBytes) return problem("Images can be up to 5 MB.", "media");
  if (!(IMAGE_MIME as readonly string[]).includes(f.declared)) return problem("Use a JPG, PNG, WebP or GIF image.", "media");
  if (!f.sniffed) return problem("That file doesn't look like an image.", "media");
  if (f.sniffed !== f.declared) return problem("The file's contents don't match its type.", "media");
  return null;
}

// ---------- celebrations ----------

export type CelebrationPerson = { id: string; name: string; designation: string | null; dob: string | null; joining_date: string; is_private: boolean };
export type Celebrant = { id: string; name: string; designation: string | null; on: ISODate; isToday: boolean; private: boolean; years?: number };

/** MM-DD keys for `days` days from today (inclusive), plus 02-29 when 28 Feb is in range of a non-leap year. Used to pre-filter in SQL. */
export function monthDays(today: ISODate, days: number): string[] {
  const out = new Set<string>();
  for (let i = 0; i < days; i++) {
    const d = addDaysISO(today, i);
    out.add(d.slice(5));
    const y = Number(d.slice(0, 4));
    const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
    if (d.slice(5) === "02-28" && !leap) out.add("02-29");
  }
  return [...out];
}

/**
 * Birthdays and work anniversaries in the next `days` days (today first), and people who joined in the last 14 days.
 * Private profiles only show their name: no designation and no link.
 */
export function celebrations(people: CelebrationPerson[], today: ISODate, days = 7) {
  const last = addDaysISO(today, days - 1);
  const mask = (p: CelebrationPerson) => ({ id: p.id, name: p.name, designation: p.is_private ? null : p.designation, private: p.is_private });
  const birthdays: Celebrant[] = [], anniversaries: Celebrant[] = [], newJoiners: Celebrant[] = [];
  for (const p of people) {
    if (p.dob) {
      const on = nextOccurrence(p.dob.slice(5), today);
      if (on <= last) birthdays.push({ ...mask(p), on, isToday: on === today });
    }
    const on = nextOccurrence(p.joining_date.slice(5), today);
    const years = Number(on.slice(0, 4)) - Number(p.joining_date.slice(0, 4));
    if (on <= last && years >= 1) anniversaries.push({ ...mask(p), on, isToday: on === today, years });
    if (p.joining_date <= today && p.joining_date >= addDaysISO(today, -13)) newJoiners.push({ ...mask(p), on: p.joining_date, isToday: p.joining_date === today });
  }
  const byDate = (a: Celebrant, b: Celebrant) => a.on.localeCompare(b.on) || a.name.localeCompare(b.name);
  return { birthdays: birthdays.sort(byDate), anniversaries: anniversaries.sort(byDate), newJoiners: newJoiners.sort((a, b) => b.on.localeCompare(a.on) || a.name.localeCompare(b.name)) };
}
