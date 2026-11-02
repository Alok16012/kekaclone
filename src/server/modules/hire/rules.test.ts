import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";
import {
  acceptanceRate, average, bySource, cleanTags, criterionAverages, DEFAULT_FLOW, DEFAULT_SCALE, DEFAULT_SCORECARD, experienceLabel, funnel, htmlToText,
  icsFor, isEmail, jobNext, mergeText, moveProblem, normalizePhone, offerNext, parseResumeText, pdfStreamText, reapplyCheck, reqCan, safeMeetingUrl,
  scoreSubmission, splitName, textToHtml, timeToHire, unknownIn, EMAIL_PLACEHOLDERS, validateFlow, validateImportRows, validateInterviewTime,
  validateScale, validateSections, validateSlots, windowStart, type FunnelApp,
} from "./rules";
import { extractResumeText } from "./resume";

const day = 864e5;

describe("state machines", () => {
  it("offers move draft → approval → draft → released → accepted/declined; finished offers are final", () => {
    expect(offerNext("draft", "submit")).toBe("pending_approval");
    expect(offerNext("pending_approval", "approve")).toBe("draft");
    expect(offerNext("draft", "release")).toBe("released");
    expect(offerNext("released", "accept")).toBe("accepted");
    expect(offerNext("released", "decline")).toBe("declined");
    expect(offerNext("accepted", "revise")).toBeNull();
    expect(offerNext("accepted", "withdraw")).toBeNull();
    expect(offerNext("declined", "accept")).toBeNull();
    expect(offerNext("pending_approval", "release")).toBeNull();
    expect(offerNext("released", "revise")).toBe("revised");
  });
  it("requisitions only convert once approved and only edit while draft or sent back", () => {
    expect(reqCan("approved", "convert")).toBe(true);
    expect(reqCan("pending", "convert")).toBe(false);
    expect(reqCan("converted", "convert")).toBe(false);
    expect(reqCan("sent_back", "edit")).toBe(true);
    expect(reqCan("approved", "edit")).toBe(false);
  });
  it("jobs publish from draft, hold and reopen, close from anywhere open", () => {
    expect(jobNext("draft", "publish")).toBe("open");
    expect(jobNext("open", "publish")).toBeNull();
    expect(jobNext("open", "hold")).toBe("on_hold");
    expect(jobNext("closed", "reopen")).toBe("open");
    expect(jobNext("closed", "edit")).toBeNull();
    expect(jobNext("open", "edit")).toBe("open");
  });
  it("manual moves can't reject or hire, and closed applications don't move", () => {
    expect(moveProblem("active", "interview")).toBeNull();
    expect(moveProblem("active", "rejected")).toMatch(/Reject/);
    expect(moveProblem("active", "hired")).toMatch(/converted/);
    expect(moveProblem("rejected", "interview")).toMatch(/no longer active/);
  });
});

describe("duplicates and reapplying", () => {
  const now = new Date("2026-11-03T10:00:00Z");
  it("normalises Indian phone numbers", () => {
    expect(normalizePhone("+91 98450-12345")).toBe("9845012345");
    expect(normalizePhone("098450 12345")).toBe("9845012345");
    expect(normalizePhone("12")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
  it("checks emails", () => {
    expect(isEmail("neha@example.com")).toBe(true);
    expect(isEmail("neha@example")).toBe(false);
    expect(isEmail("a b@example.com")).toBe(false);
  });
  it("cooldown: active and hired block, closed ones reopen after the cooldown, no cooldown means never", () => {
    expect(reapplyCheck(null, 30, now)).toEqual({ ok: true, reopen: false });
    expect(reapplyCheck({ status: "active", closedAt: null }, 30, now)).toEqual({ ok: false, reason: "active" });
    expect(reapplyCheck({ status: "hired", closedAt: null }, 30, now)).toEqual({ ok: false, reason: "hired" });
    expect(reapplyCheck({ status: "rejected", closedAt: new Date(now.getTime() - 10 * day) }, null, now)).toEqual({ ok: false, reason: "no_reapply" });
    const r = reapplyCheck({ status: "rejected", closedAt: new Date(now.getTime() - 10 * day) }, 30, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.until?.toISOString()).toBe(new Date(now.getTime() + 20 * day).toISOString());
    expect(reapplyCheck({ status: "withdrawn", closedAt: new Date(now.getTime() - 31 * day) }, 30, now)).toEqual({ ok: true, reopen: true });
    expect(reapplyCheck({ status: "rejected", closedAt: new Date(now.getTime() - 1) }, 0, now)).toEqual({ ok: true, reopen: true });
  });
  it("splits names", () => {
    expect(splitName("  Neha   Rani Gupta ")).toEqual({ first: "Neha", last: "Rani Gupta" });
    expect(splitName("Neha")).toEqual({ first: "Neha", last: null });
  });
});

describe("scorecards", () => {
  const card = { sections: DEFAULT_SCORECARD, points: DEFAULT_SCALE, overallRating: false };
  const all = { problem_solving: 4, domain: 3, communication: 5, ownership: 4 };
  it("needs every criterion on the scale and a recommendation; overall is the mean", () => {
    expect(scoreSubmission(card, { ratings: { ...all, domain: undefined as unknown as number }, overall: null, recommendation: "yes" })).toEqual({ ok: false, error: 'Rate "Knowledge of the domain".' });
    expect(scoreSubmission(card, { ratings: { ...all, domain: 9 }, overall: null, recommendation: "yes" }).ok).toBe(false);
    expect(scoreSubmission(card, { ratings: all, overall: null, recommendation: "maybe" }).ok).toBe(false);
    expect(scoreSubmission(card, { ratings: { ...all, extra: 1 }, overall: null, recommendation: "yes" })).toEqual({ ok: true, overall: 4, ratings: all });
  });
  it("uses the given overall when the card asks for one", () => {
    const c2 = { ...card, overallRating: true };
    expect(scoreSubmission(c2, { ratings: all, overall: null, recommendation: "yes" }).ok).toBe(false);
    expect(scoreSubmission(c2, { ratings: all, overall: 2, recommendation: "no" })).toMatchObject({ ok: true, overall: 2 });
  });
  it("averages", () => {
    expect(average([4, 3.5, null, 5])).toBe(4.2);
    expect(average([])).toBeNull();
    expect(criterionAverages([{ a: 4, b: 2 }, { a: 5 }])).toEqual({ a: 4.5, b: 2 });
  });
  it("validates scales and sections", () => {
    expect(validateScale(DEFAULT_SCALE)).toBeNull();
    expect(validateScale([{ value: 1, label: "x" }])).toMatch(/2 to 10/);
    expect(validateScale([{ value: 1, label: "a" }, { value: 1, label: "b" }])).toMatch(/own value/);
    expect(validateSections(DEFAULT_SCORECARD)).toBeNull();
    expect(validateSections([{ title: "A", criteria: [{ id: "x", label: "X" }] }, { title: "B", criteria: [{ id: "x", label: "Y" }] }])).toMatch(/unique/);
    expect(validateSections([])).toMatch(/1 and 12/);
  });
});

describe("flows", () => {
  it("the default flow is valid", () => expect(validateFlow(DEFAULT_FLOW)).toBeNull());
  it("needs one hired and one rejected stage, in group order, unique names", () => {
    expect(validateFlow(DEFAULT_FLOW.filter((s) => s.group !== "hired"))).toMatch(/one Hired/);
    expect(validateFlow(DEFAULT_FLOW.filter((s) => s.group !== "rejected"))).toMatch(/rejected/);
    expect(validateFlow([{ name: "Offer", group: "offer" }, { name: "Screen", group: "screening" }, { name: "Hired", group: "hired" }, { name: "No", group: "rejected" }])).toMatch(/out of order/);
    expect(validateFlow([{ name: "A", group: "sourced" }, { name: "a", group: "screening" }, { name: "Hired", group: "hired" }, { name: "No", group: "rejected" }])).toMatch(/different/);
  });
});

describe("slots and calendar", () => {
  const now = new Date("2026-11-03T04:00:00Z");
  const s = (h: number, mins = 60) => ({ start: new Date(now.getTime() + h * 3600e3), end: new Date(now.getTime() + h * 3600e3 + mins * 60e3) });
  it("validates offered slots", () => {
    expect(validateSlots([s(24), s(26)], now)).toBeNull();
    expect(validateSlots([], now)).toMatch(/at least one/);
    expect(validateSlots([s(-1)], now)).toMatch(/future/);
    expect(validateSlots([s(24), s(24.5)], now)).toMatch(/overlap/);
    expect(validateSlots([s(24, 5)], now)).toMatch(/15 minutes/);
    expect(validateSlots(Array.from({ length: 11 }, (_, i) => s(24 + i * 2)), now)).toMatch(/at most 10/);
  });
  it("validates a fixed interview time", () => {
    expect(validateInterviewTime(s(2).start, s(2).end, now)).toBeNull();
    expect(validateInterviewTime(s(2).end, s(2).start, now)).toMatch(/end after/);
  });
  it("writes an escaped calendar file", () => {
    const ics = icsFor({ uid: "abc", start: new Date("2026-11-04T05:00:00Z"), end: new Date("2026-11-04T06:00:00Z"), title: "Interview, round 1", description: "Line 1\nLine 2", location: null, now });
    expect(ics).toContain("DTSTART:20261104T050000Z");
    expect(ics).toContain("SUMMARY:Interview\\, round 1");
    expect(ics).toContain("DESCRIPTION:Line 1\\nLine 2");
    expect(ics).not.toContain("LOCATION");
  });
  it("only keeps http(s) meeting links", () => {
    expect(safeMeetingUrl("https://meet.example.com/abc")).toBe("https://meet.example.com/abc");
    expect(safeMeetingUrl("javascript:alert(1)")).toBeNull();
    expect(safeMeetingUrl("")).toBeNull();
  });
});

describe("analytics", () => {
  const at = (d: number) => new Date(Date.UTC(2026, 9, 1) + d * day);
  const apps: FunnelApp[] = [
    { furthest: "hired", status: "hired", source: "referral", createdAt: at(0), hiredAt: at(30) },
    { furthest: "offer", status: "active", source: "career_site", createdAt: at(0), hiredAt: null },
    { furthest: "interview", status: "rejected", source: "career_site", createdAt: at(0), hiredAt: null },
    { furthest: "sourced", status: "active", source: "manual", createdAt: at(0), hiredAt: null },
    { furthest: "hired", status: "hired", source: "career_site", createdAt: at(0), hiredAt: at(20) },
  ];
  it("counts each group reached, with conversion from the group before", () => {
    const f = funnel(apps);
    expect(f.map((x) => x.count)).toEqual([5, 4, 4, 3, 2]);
    expect(f.map((x) => x.conversion)).toEqual([null, 80, 100, 75, 67]);
  });
  it("breaks down by source and time to hire", () => {
    expect(bySource(apps)[0]).toMatchObject({ source: "career_site", applied: 3, hired: 1 });
    expect(timeToHire(apps)).toEqual({ average: 25, median: 25, hires: 2 });
    expect(timeToHire([])).toEqual({ average: null, median: null, hires: 0 });
  });
  it("acceptance rate counts expired as not accepted", () => {
    expect(acceptanceRate([{ status: "accepted" }, { status: "declined" }, { status: "expired" }, { status: "released" }])).toEqual({ accepted: 1, declined: 2, rate: 33 });
    expect(acceptanceRate([]).rate).toBeNull();
  });
  it("rate-limit windows are fixed", () => {
    expect(windowStart(new Date("2026-11-03T10:47:12Z"), 60).toISOString()).toBe("2026-11-03T10:00:00.000Z");
  });
});

describe("text and templates", () => {
  it("text ↔ html", () => {
    expect(textToHtml("Hi <b>\n\nLine 1\nLine 2")).toBe("<p>Hi &lt;b&gt;</p><p>Line 1<br>Line 2</p>");
    expect(htmlToText("<p>Hi &amp; bye</p><ul><li>One</li></ul>")).toBe("Hi & bye\n• One");
  });
  it("merges and finds unknown placeholders", () => {
    expect(mergeText("Hi {{candidate.first_name}}, {{ job.title }}{{missing}}", { "candidate.first_name": "Neha", "job.title": "SDE" })).toBe("Hi Neha, SDE");
    expect(unknownIn("{{candidate.name}} {{salary.secret}}", EMAIL_PLACEHOLDERS)).toEqual(["salary.secret"]);
  });
  it("tags and experience labels", () => {
    expect(cleanTags([" Java ", "java", "", "Node  JS"])).toEqual(["java", "node js"]);
    expect(experienceLabel(63)).toBe("5 yrs 3 mos");
    expect(experienceLabel(0)).toBe("Fresher");
    expect(experienceLabel(null)).toBeNull();
  });
});

describe("import rows", () => {
  it("validates required fields, emails, duplicates and experience", () => {
    const r = validateImportRows([
      { row: 2, values: { firstName: "Neha", email: "NEHA@x.com", experienceYears: "4.5", tags: "a, b" } },
      { row: 3, values: { firstName: "", email: "x@y.com" } },
      { row: 4, values: { firstName: "Ravi", email: "neha@x.com" } },
      { row: 5, values: { firstName: "Om", email: "bad" } },
      { row: 6, values: { firstName: "Om", email: "om@x.com", experienceYears: "-1" } },
      { row: 7, values: { firstName: "", email: "" } },
    ]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ email: "neha@x.com", experienceMonths: 54, tags: ["a", "b"] });
    expect(r.errors.map((e) => e.row)).toEqual([3, 4, 5, 6]);
  });
});

describe("resume parsing", () => {
  const text = "Neha Gupta\nBackend engineer\nneha.gupta@example.com | +91 98450 12345\nlinkedin.com/in/nehag\n6 years of experience with Java, PostgreSQL and AWS.";
  it("finds contact details, experience and skills", () => {
    expect(parseResumeText(text)).toEqual({ email: "neha.gupta@example.com", phone: "9845012345", name: "Neha Gupta", experienceYears: 6, skills: ["java", "postgresql", "aws"], linkedin: "linkedin.com/in/nehag" });
    expect(parseResumeText("")).toMatchObject({ email: null, phone: null, name: null, skills: [] });
  });
  it("reads text operators from a PDF stream", () => {
    expect(pdfStreamText("BT /F1 12 Tf (Neha Gupta) Tj T* [(neha@ex) 10 (ample.com)] TJ ET")).toBe("Neha Gupta\nneha@example.com\n");
    expect(pdfStreamText("BT (a\\(b\\)) Tj ET")).toBe("a(b)\n");
    expect(pdfStreamText("BT <4E656861> Tj [<20> -300 <4775>] TJ ET")).toBe("Neha  Gu\n");
  });
  it("extracts text from plain and compressed PDF streams", () => {
    const content = "BT /F1 12 Tf 72 720 Td (Neha Gupta) Tj T* (neha.gupta@example.com) Tj ET";
    const z = deflateSync(Buffer.from(content, "latin1"));
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n1 0 obj\n<< /Length " + z.length + " /Filter /FlateDecode >>\nstream\n", "latin1"), z, Buffer.from("\nendstream\nendobj\n%%EOF", "latin1")]);
    const out = extractResumeText("cv.pdf", new Uint8Array(pdf));
    expect(out).toContain("Neha Gupta");
    expect(out).toContain("neha.gupta@example.com");
    expect(extractResumeText("cv.txt", new TextEncoder().encode("hello"))).toBe("hello");
    expect(extractResumeText("cv.docx", new Uint8Array([1, 2]))).toBe("");
    expect(extractResumeText("broken.pdf", new TextEncoder().encode("%PDF-1.4 << /Filter /FlateDecode >>\nstream\nnot zlib\nendstream"))).toBe("");
  });
});
