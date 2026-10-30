import { describe, expect, it } from "vitest";
import {
  announcementStatus, celebrations, checkImage, decodeCursor, encodeCursor, endOfDayIST, monthDays, percentages, sniffImage,
  validateDraft, validateVote, type CelebrationPerson, type DraftInput,
} from "./rules";

const now = new Date("2026-10-30T06:00:00Z");
const ctx = { authorId: "me", now, today: "2026-10-30" };
const v = (d: DraftInput) => validateDraft(d, ctx)?.message ?? null;

describe("validateDraft", () => {
  it("post needs text or an image, within the limit", () => {
    expect(v({ kind: "post", body: "  " })).toMatch(/Write something/);
    expect(v({ kind: "post", body: "", mediaFileIds: ["f1"] })).toBeNull();
    expect(v({ kind: "post", body: "Hello team" })).toBeNull();
    expect(v({ kind: "post", body: "x".repeat(3001) })).toMatch(/under 3000/);
    expect(v({ kind: "post", body: "hi", mediaFileIds: ["a", "b", "c", "d", "e"] })).toMatch(/up to 4/);
  });

  it("only announcements go to locations, get pinned or scheduled", () => {
    expect(v({ kind: "post", body: "hi", audience: { type: "locations", ids: ["l1"] } })).toMatch(/Only announcements/);
    expect(v({ kind: "post", body: "hi", pinnedUntil: "2026-11-01" })).toMatch(/pinned or scheduled/);
    expect(v({ kind: "post", body: "hi", audience: { type: "departments", ids: [] } })).toMatch(/at least one department/);
  });

  it("announcement: title + text; pin date not in the past; schedule not in the past", () => {
    const base: DraftInput = { kind: "announcement", title: "Office closed Friday", body: "Diwali break", audience: { type: "org" } };
    expect(v(base)).toBeNull();
    expect(v({ ...base, title: "" })).toMatch(/title/);
    expect(v({ ...base, body: "" })).toMatch(/announcement text/);
    expect(v({ ...base, pinnedUntil: "2026-10-29" })).toMatch(/past/);
    expect(v({ ...base, pinnedUntil: "2026-10-30" })).toBeNull();
    expect(v({ ...base, publishAt: "2026-10-30T05:00:00Z" })).toMatch(/already passed/);
    expect(v({ ...base, publishAt: "2026-10-30T05:58:00Z" })).toBeNull();   // a couple of minutes of clock skew is fine
    expect(v({ ...base, publishAt: "2026-11-02T04:30:00Z" })).toBeNull();
    expect(v({ ...base, audience: { type: "locations", ids: ["l1"] } })).toBeNull();
  });

  it("poll: a question, 2–10 distinct options, end date in the future", () => {
    const base: DraftInput = { kind: "poll", body: "Team lunch?", poll: { options: ["Pizza", "Biryani"], multiple: false, anonymous: false, endsAt: null } };
    expect(v(base)).toBeNull();
    expect(v({ ...base, body: "" })).toMatch(/question/);
    expect(v({ ...base, poll: { ...base.poll!, options: ["Pizza", "  "] } })).toMatch(/at least two/);
    expect(v({ ...base, poll: { ...base.poll!, options: ["Pizza", "pizza "] } })).toMatch(/same/);
    expect(v({ ...base, poll: { ...base.poll!, options: Array.from({ length: 11 }, (_, i) => `o${i}`) } })).toMatch(/at most 10/);
    expect(v({ ...base, poll: { ...base.poll!, endsAt: "2026-10-30T05:00:00Z" } })).toMatch(/future/);
    expect(v({ ...base, poll: { ...base.poll!, endsAt: "2026-11-06T18:29:59Z" } })).toBeNull();
    expect(v({ ...base, mediaFileIds: ["f"] })).toMatch(/Images can only/);
  });

  it("praise: someone else, no repeats, a badge and a message", () => {
    const base: DraftInput = { kind: "praise", body: "Shipped the release", praise: { recipientIds: ["a", "b"], badgeId: "badge" } };
    expect(v(base)).toBeNull();
    expect(v({ ...base, praise: { recipientIds: [], badgeId: "badge" } })).toMatch(/who/);
    expect(v({ ...base, praise: { recipientIds: ["a", "me"], badgeId: "badge" } })).toMatch(/yourself/);
    expect(v({ ...base, praise: { recipientIds: ["a", "a"], badgeId: "badge" } })).toMatch(/twice/);
    expect(v({ ...base, praise: { recipientIds: ["a"], badgeId: "" } })).toMatch(/badge/);
    expect(v({ ...base, body: " " })).toMatch(/what they did/);
    expect(v({ ...base, praise: { recipientIds: Array.from({ length: 11 }, (_, i) => `p${i}`), badgeId: "b" } })).toMatch(/up to 10/);
  });
});

describe("validateVote", () => {
  const poll = { multiple: false, optionIds: ["a", "b", "c"], endsAt: null };
  it("single choice takes exactly one known option", () => {
    expect(validateVote(["a"], poll, now)).toBeNull();
    expect(validateVote([], poll, now)?.message).toMatch(/Pick/);
    expect(validateVote(["a", "b"], poll, now)?.message).toMatch(/one answer/);
    expect(validateVote(["z"], poll, now)?.message).toMatch(/isn't part/);
  });
  it("multiple choice allows several but no repeats; closed polls refuse", () => {
    expect(validateVote(["a", "c"], { ...poll, multiple: true }, now)).toBeNull();
    expect(validateVote(["a", "a"], { ...poll, multiple: true }, now)?.message).toMatch(/once/);
    expect(validateVote(["a"], { ...poll, endsAt: "2026-10-30T06:00:00Z" }, now)?.message).toMatch(/closed/);
  });
});

describe("percentages", () => {
  it("adds up to 100 and handles no votes", () => {
    expect(percentages([1, 1, 1])).toEqual([34, 33, 33]);
    expect(percentages([0, 0])).toEqual([0, 0]);
    expect(percentages([3, 1])).toEqual([75, 25]);
    expect(percentages([2, 0, 1]).reduce((a, b) => a + b)).toBe(100);
    expect(percentages([5])).toEqual([100]);
  });
});

describe("announcement status and pins", () => {
  it("scheduled before publish time, expired after expiry", () => {
    expect(announcementStatus(new Date("2026-10-31T00:00:00Z"), null, now)).toBe("scheduled");
    expect(announcementStatus(new Date("2026-10-29T00:00:00Z"), null, now)).toBe("live");
    expect(announcementStatus(new Date("2026-10-29T00:00:00Z"), new Date("2026-10-30T00:00:00Z"), now)).toBe("expired");
  });
  it("pin until a date lasts through that day in India", () => {
    expect(endOfDayIST("2026-11-01").toISOString()).toBe("2026-11-01T18:29:59.999Z");
  });
});

describe("cursor", () => {
  it("round-trips and rejects junk", () => {
    const c = { at: "2026-10-30T06:00:00.123456Z", id: "2f1d7c1e-5b7a-4c1e-9a7e-1d2c3b4a5f60" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor("not-a-cursor")).toBeNull();
    expect(decodeCursor(encodeCursor({ at: "yesterday", id: c.id }))).toBeNull();
    expect(decodeCursor(encodeCursor({ at: c.at, id: "1; drop table posts" }))).toBeNull();
    expect(decodeCursor(null)).toBeNull();
  });
});

describe("images", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const gif = new TextEncoder().encode("GIF89a....");
  const webp = new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ");
  it("sniffs the real type from the first bytes", () => {
    expect(sniffImage(png)).toBe("image/png");
    expect(sniffImage(jpg)).toBe("image/jpeg");
    expect(sniffImage(gif)).toBe("image/gif");
    expect(sniffImage(webp)).toBe("image/webp");
    expect(sniffImage(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
  });
  it("checks size, allowed type and that the contents match", () => {
    expect(checkImage({ size: 1000, declared: "image/png", sniffed: "image/png" })).toBeNull();
    expect(checkImage({ size: 0, declared: "image/png", sniffed: "image/png" })?.message).toMatch(/empty/);
    expect(checkImage({ size: 6 * 1024 * 1024, declared: "image/png", sniffed: "image/png" })?.message).toMatch(/5 MB/);
    expect(checkImage({ size: 10, declared: "image/svg+xml", sniffed: null })?.message).toMatch(/JPG, PNG/);
    expect(checkImage({ size: 10, declared: "image/png", sniffed: null })?.message).toMatch(/doesn't look/);
    expect(checkImage({ size: 10, declared: "image/png", sniffed: "image/jpeg" })?.message).toMatch(/don't match/);
  });
});

describe("celebrations", () => {
  const p = (id: string, o: Partial<CelebrationPerson>): CelebrationPerson => ({ id, name: id, designation: "Engineer", dob: null, joining_date: "2020-01-15", is_private: false, ...o });
  const today = "2026-10-30";
  it("birthdays and anniversaries this week, today first; new joiners from the last two weeks", () => {
    const c = celebrations([
      p("today", { dob: "1990-10-30" }), p("sunday", { dob: "1992-11-01" }), p("later", { dob: "1990-11-20" }),
      p("anniv", { joining_date: "2023-11-02" }), p("firstyear", { joining_date: "2026-10-30" }), p("joined", { joining_date: "2026-10-20" }),
      p("old-joiner", { joining_date: "2026-10-01" }),
    ], today);
    expect(c.birthdays.map((x) => x.id)).toEqual(["today", "sunday"]);
    expect(c.birthdays[0].isToday).toBe(true);
    expect(c.anniversaries).toEqual([expect.objectContaining({ id: "anniv", years: 3, on: "2026-11-02" })]);
    expect(c.newJoiners.map((x) => x.id)).toEqual(["firstyear", "joined"]);
  });
  it("year-end wrap and private profiles show only the name", () => {
    const c = celebrations([p("ny", { dob: "1991-01-02", is_private: true })], "2026-12-29");
    expect(c.birthdays).toEqual([expect.objectContaining({ id: "ny", on: "2027-01-02", designation: null, private: true })]);
  });
  it("month-day keys for the SQL pre-filter include 29 Feb in non-leap years", () => {
    expect(monthDays("2027-02-27", 3)).toEqual(["02-27", "02-28", "02-29", "03-01"]);
    expect(monthDays("2026-12-30", 3)).toEqual(["12-30", "12-31", "01-01"]);
  });
});
