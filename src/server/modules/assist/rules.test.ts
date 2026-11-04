import { describe, expect, it } from "vitest";
import {
  clampScore, erasureBlocker, excerpt, jdTerms, keywordMatch, mentions, namedTerms, outlineJd, passages, redactContact, reminderDue, retentionCutoff, scoreBand,
  searchPolicies, searchSuggestion, stripHtml, validCitationNumbers, whenWords, words,
} from "./rules";

describe("text helpers", () => {
  it("tokenises without stop words and keeps tech names", () => {
    expect(words("We need strong experience with Node.js, C++ and React.")).toEqual(["need", "node.js", "c++", "react"]);
  });
  it("matches whole words only", () => {
    expect(mentions("Built services in Go and Java", "go")).toBe(true);
    expect(mentions("Good at golang", "go")).toBe(false);
    expect(mentions("Shipped c++ tools", "c++")).toBe(true);
  });
  it("strips html to text", () => {
    expect(stripHtml("<h2>Role</h2><p>Hello&nbsp;<b>world</b></p><ul><li>a</li></ul>")).toBe("Role\nHello world\na");
  });
});

describe("redactContact", () => {
  it("removes emails, phones, links and ID numbers before text leaves the app", () => {
    const r = redactContact("Asha Rao asha.rao@mail.com +91 98765 43210 linkedin.com/in/asha https://x.dev ABCDE1234F 1234 5678 9012 5 years Java");
    expect(r).not.toMatch(/asha\.rao@|98765|linkedin|x\.dev|ABCDE1234F|1234 5678/);
    expect(r).toContain("5 years Java");
  });
});

describe("keywordMatch", () => {
  const jd = "Backend engineer. You will build APIs in Java and Spring, run PostgreSQL, deploy on AWS with Docker.";
  it("scores overlap, listed skills count double, and explains", () => {
    const r = keywordMatch({ jdText: jd, skills: ["Java", "Kubernetes"], resumeText: "Java developer, Spring Boot, PostgreSQL and AWS." });
    expect(r.matched).toEqual(expect.arrayContaining(["java", "spring", "postgresql", "aws"]));
    expect(r.missing).toEqual(expect.arrayContaining(["kubernetes", "docker"]));
    expect(r.score).toBeGreaterThan(30);
    expect(r.score).toBeLessThan(90);
    expect(r.gaps.join(" ")).toMatch(/kubernetes/);
    expect(r.summary).toMatch(/Keyword overlap only/);
  });
  it("lowers the score when stated experience is under the minimum", () => {
    const base = keywordMatch({ jdText: jd, resumeText: "Java Spring PostgreSQL AWS Docker" });
    const junior = keywordMatch({ jdText: jd, resumeText: "Java Spring PostgreSQL AWS Docker", experienceMin: 5, experienceYears: 2 });
    expect(junior.score).toBeLessThan(base.score);
    expect(junior.gaps[0]).toMatch(/2 years/);
  });
  it("empty JD gives zero with a reason", () => {
    expect(keywordMatch({ jdText: "", resumeText: "anything" })).toMatchObject({ score: 0, matched: [] });
  });
  it("jdTerms puts skills first and caps the list", () => {
    expect(jdTerms("python python data data data", ["SQL"]).slice(0, 3)).toEqual(["sql", "data", "python"]);
    expect(jdTerms("a ".repeat(5) + Array.from({ length: 60 }, (_, i) => `term${i}`).join(" ")).length).toBe(24);
  });
  it("bands and clamps", () => {
    expect(scoreBand(80).label).toBe("Strong match");
    expect(scoreBand(50).label).toBe("Partial match");
    expect(scoreBand(10).label).toBe("Weak match");
    expect(clampScore(140)).toBe(100); expect(clampScore(-3)).toBe(0); expect(clampScore("x")).toBe(0); expect(clampScore(41.6)).toBe(42);
  });
});

describe("outlineJd", () => {
  it("builds sections from the brief and escapes input", () => {
    const html = outlineJd({ title: "Data <Analyst>", skills: ["SQL", "Excel"], experienceMin: 2, experienceMax: 4, jobType: "full_time", department: "Finance", location: "Pune", company: "Acme" });
    expect(html).toContain("Data &lt;Analyst&gt;");
    expect(html).toContain("2 to 4 years");
    expect(html).toContain("Hands-on experience with SQL.");
    expect(html).toContain("full-time");
    expect(html).not.toContain("<Analyst>");
  });
});

describe("policy search", () => {
  const docs = [
    { id: "d1", title: "Leave policy", text: "Earned leave: 18 days a year, credited monthly.\n\nSick leave: 12 days a year. A doctor's note is needed for more than 2 days in a row." },
    { id: "d2", title: "Travel policy", text: "Book flights through the travel desk. Economy class for trips under 4 hours. Hotel limit is Rs 5,000 a night." },
  ];
  it("splits long text into passages", () => {
    expect(passages("a. ".repeat(600), 200).every((p) => p.length <= 320)).toBe(true);
    expect(passages("one\n\ntwo")).toEqual(["one two"]);
  });
  it("finds the passage that answers the question, one per document first", () => {
    const hits = searchPolicies("How many sick leave days do I get?", docs);
    expect(hits[0].docId).toBe("d1");
    expect(hits[0].text).toMatch(/Sick leave/);
    expect(searchPolicies("hotel limit per night", docs)[0].docId).toBe("d2");
    expect(searchPolicies("the and of", docs)).toEqual([]);
  });
  it("search answer cites its sources and is empty when nothing matches", () => {
    const s = searchSuggestion("sick leave doctor note", docs);
    expect(s.citations[0]).toMatchObject({ n: 1, docId: "d1", title: "Leave policy" });
    expect(s.answer).toMatch(/\[1\]/);
    expect(searchSuggestion("parking", docs)).toEqual({ answer: "", citations: [], confident: false });
  });
  it("keeps only real citation numbers", () => {
    expect(validCitationNumbers([1, 2, 2, 7, 0, "x"], 3)).toEqual([1, 2]);
    expect(validCitationNumbers(null, 3)).toEqual([]);
    expect(excerpt("word ".repeat(100), 20).endsWith("…")).toBe(true);
  });
});

describe("candidate privacy", () => {
  it("retention cutoff goes back whole months and clamps month ends", () => {
    expect(retentionCutoff("2026-11-04", 12)).toBe("2025-11-04");
    expect(retentionCutoff("2026-03-31", 1)).toBe("2026-02-28");
    expect(retentionCutoff("2026-01-15", 18)).toBe("2024-07-15");
  });
  it("erasure is blocked for employees, live offers and already-removed records", () => {
    const base = { employeeId: null, anonymised: false, liveOffer: false, activeApplications: 1 };
    expect(erasureBlocker(base)).toBeNull();
    expect(erasureBlocker({ ...base, employeeId: "e" })).toMatch(/employee/);
    expect(erasureBlocker({ ...base, liveOffer: true })).toMatch(/Withdraw/);
    expect(erasureBlocker({ ...base, anonymised: true })).toMatch(/already/);
  });
});

describe("interview reminders", () => {
  const now = new Date("2026-11-04T10:00:00Z");
  const at = (h: number) => new Date(now.getTime() + h * 3600_000);
  it("is due once, for scheduled interviews in the next day", () => {
    expect(reminderDue({ status: "scheduled", starts_at: at(5), reminder_sent_at: null }, now)).toBe(true);
    expect(reminderDue({ status: "scheduled", starts_at: at(30), reminder_sent_at: null }, now)).toBe(false);
    expect(reminderDue({ status: "scheduled", starts_at: at(-1), reminder_sent_at: null }, now)).toBe(false);
    expect(reminderDue({ status: "scheduled", starts_at: at(5), reminder_sent_at: now }, now)).toBe(false);
    expect(reminderDue({ status: "cancelled", starts_at: at(5), reminder_sent_at: null }, now)).toBe(false);
    expect(reminderDue({ status: "awaiting_candidate", starts_at: null, reminder_sent_at: null }, now)).toBe(false);
  });
  it("says today / tomorrow", () => {
    expect(whenWords("2026-11-04", "2026-11-04")).toBe("today");
    expect(whenWords("2026-11-05", "2026-11-04")).toBe("tomorrow");
    expect(whenWords("2026-11-09", "2026-11-04")).toBe("soon");
  });
});

describe("namedTerms", () => {
  it("picks tool names, including short capitalised list lines, and skips sentence starts", () => {
    const t = "About the role\nYou'll build services in Java.\n• Design and test features end to end\n• PostgreSQL\n• AWS, Docker and Kubernetes\nWe use C++ and Node.js.";
    const n = namedTerms(t);
    expect(n).toEqual(expect.arrayContaining(["java", "postgresql", "aws", "docker", "kubernetes", "c++", "node.js"]));
    expect(n).not.toContain("design");
    expect(n).not.toContain("you");
  });
  it("puts named tools ahead of frequent generic words in the JD terms", () => {
    const terms = jdTerms("Build build build services services.\nTools we use\n• Java and Spring");
    expect(terms.slice(0, 2)).toEqual(["java", "spring"]);
  });
});
