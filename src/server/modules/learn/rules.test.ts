import { describe, expect, it } from "vitest";
import {
  cleanContent, describeRule, dueDateFor, embedUrl, enrollmentState, isComplete, learnerQuiz, nextModule, parseRule, percentDone, reminderDue, ruleMatches, sanitizeReading, scoreQuiz,
  validateCourse, validateModule, type QuizContent,
} from "./rules";

const quiz: QuizContent = { pass_pct: 70, questions: [
  { id: "q1", text: "2+2?", options: ["3", "4"], correct: 1 },
  { id: "q2", text: "Capital of India?", options: ["Delhi", "Mumbai", "Pune"], correct: 0 },
  { id: "q3", text: "Sky colour?", options: ["Blue", "Green"], correct: 0 },
] };

describe("modules", () => {
  it("validates each kind", () => {
    expect(validateModule({ title: "Intro", kind: "video", content: { url: "https://youtu.be/abc12345" }, hasFile: false })).toEqual([]);
    expect(validateModule({ title: "Intro", kind: "video", content: { url: "https://example.com/page" }, hasFile: false })[0].field).toBe("url");
    expect(validateModule({ title: "Intro", kind: "video", content: {}, hasFile: true })).toEqual([]);
    expect(validateModule({ title: "Policy", kind: "document", content: {}, hasFile: false })[0].field).toBe("file");
    expect(validateModule({ title: "Read", kind: "text", content: { html: "<p> </p>" }, hasFile: false })[0].field).toBe("html");
    expect(validateModule({ title: "", kind: "link", content: { url: "ftp://x" }, hasFile: false }).map((p) => p.field)).toEqual(["title", "url"]);
    expect(validateModule({ title: "Q", kind: "quiz", content: quiz, hasFile: false })).toEqual([]);
    const bad = validateModule({ title: "Q", kind: "quiz", content: { pass_pct: 150, questions: [{ text: "", options: ["a"], correct: 3 }] }, hasFile: false });
    expect(bad.map((p) => p.field)).toEqual(expect.arrayContaining(["questions.0.text", "questions.0.options", "questions.0.correct", "pass_pct"]));
    expect(validateModule({ title: "Q", kind: "nope", content: {}, hasFile: false })[0].field).toBe("kind");
  });
  it("cleans content and hides answer keys from learners", () => {
    const c = cleanContent("quiz", { pass_pct: "80", questions: [{ text: " A? ", options: ["x", "", "y"], correct: "1" }] });
    expect(c).toEqual({ kind: "quiz", pass_pct: 80, questions: [{ id: "q1", text: "A?", options: ["x", "y"], correct: 1 }] });
    expect(learnerQuiz(quiz).questions[0]).not.toHaveProperty("correct");
    expect(cleanContent("video", { url: "  https://youtu.be/x  " })).toEqual({ kind: "video", url: "https://youtu.be/x" });
  });
  it("scores quizzes against the pass mark", () => {
    expect(scoreQuiz(quiz, [1, 0, 0])).toMatchObject({ score: 3, total: 3, pct: 100, passed: true });
    expect(scoreQuiz(quiz, [1, 1, 0])).toMatchObject({ score: 2, pct: 67, passed: false });
    expect(scoreQuiz(quiz, [1])).toMatchObject({ score: 1, answers: [1, null, null] });
    expect(scoreQuiz({ ...quiz, pass_pct: 60 }, [1, 1, 0]).passed).toBe(true);
    expect(scoreQuiz({ pass_pct: 50, questions: [] }, []).passed).toBe(false);
  });
  it("sanitises readings and derives embeds", () => {
    expect(sanitizeReading('<p onclick="x">Hi <script>alert(1)</script><a href="https://a.b" onclick="y">link</a><img src=x></p>')).toBe('<p>Hi <a href="https://a.b" rel="noopener noreferrer" target="_blank">link</a></p>');
    expect(embedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({ kind: "iframe", src: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" });
    expect(embedUrl("https://vimeo.com/12345")).toEqual({ kind: "iframe", src: "https://player.vimeo.com/video/12345" });
    expect(embedUrl("https://cdn.x/y.mp4")).toEqual({ kind: "file", src: "https://cdn.x/y.mp4" });
  });
});

describe("progress", () => {
  const ids = ["a", "b", "c"];
  it("computes percent, completion and the next module", () => {
    expect(percentDone(ids, {})).toBe(0);
    expect(percentDone(ids, { modules: { a: { done_at: "x" } } })).toBe(33.33);
    expect(isComplete(ids, { modules: { a: { done_at: "x" }, b: { done_at: "x" }, c: { done_at: "x" } } })).toBe(true);
    expect(isComplete([], {})).toBe(false);
    expect(nextModule(ids, { modules: { a: { done_at: "x" } } })).toBe("b");
  });
  it("derives the enrolment state", () => {
    expect(enrollmentState({ percent: 0, completed_at: null, due_date: null }, "2026-11-03")).toBe("not_started");
    expect(enrollmentState({ percent: 40, completed_at: null, due_date: "2026-12-01" }, "2026-11-03")).toBe("in_progress");
    expect(enrollmentState({ percent: 40, completed_at: null, due_date: "2026-11-01" }, "2026-11-03")).toBe("overdue");
    expect(enrollmentState({ percent: 100, completed_at: "2026-10-01", due_date: "2026-09-01" }, "2026-11-03")).toBe("completed");
  });
  it("sends one reminder per day from the lead time until it's done", () => {
    const e = { due_date: "2026-11-10", completed_at: null, reminded_on: null };
    expect(reminderDue(e, 3, "2026-11-03")).toBe(false);
    expect(reminderDue(e, 3, "2026-11-07")).toBe(true);
    expect(reminderDue(e, 3, "2026-11-20")).toBe(true);
    expect(reminderDue({ ...e, reminded_on: "2026-11-07" }, 3, "2026-11-07")).toBe(false);
    expect(reminderDue({ ...e, completed_at: "x" }, 3, "2026-11-07")).toBe(false);
    expect(reminderDue(e, null, "2026-11-07")).toBe(false);
    expect(dueDateFor("2026-11-03", 7)).toBe("2026-11-10");
    expect(dueDateFor("2026-11-03", null)).toBeNull();
  });
});

describe("assignment rules", () => {
  const p = { id: "e1", department_id: "d1", location_id: "l1", designation_id: "g1", joining_date: "2026-10-20" };
  it("parses and matches", () => {
    expect(parseRule({ kind: "everyone" })).toEqual({ kind: "everyone" });
    expect(parseRule({ kind: "people", ids: [] })).toBeNull();
    expect(parseRule({ kind: "new_joiners", within_days: 0 })).toBeNull();
    expect(parseRule({ kind: "bogus" })).toBeNull();
    const id = "11111111-1111-4111-8111-111111111111";
    expect(parseRule({ kind: "departments", ids: [id, id, "junk"] })).toEqual({ kind: "departments", ids: [id] });
    expect(ruleMatches({ kind: "departments", ids: ["d1"] }, p, "2026-11-03")).toBe(true);
    expect(ruleMatches({ kind: "locations", ids: ["l9"] }, p, "2026-11-03")).toBe(false);
    expect(ruleMatches({ kind: "people", ids: ["e1"] }, p, "2026-11-03")).toBe(true);
    expect(ruleMatches({ kind: "new_joiners", within_days: 30 }, p, "2026-11-03")).toBe(true);
    expect(ruleMatches({ kind: "new_joiners", within_days: 7 }, p, "2026-11-03")).toBe(false);
    expect(ruleMatches({ kind: "new_joiners", within_days: 7 }, p, "2026-10-19")).toBe(false);   // not joined yet
    expect(describeRule({ kind: "designations", ids: ["g1"] }, () => ["Engineer"])).toBe("Designations: Engineer");
    expect(describeRule({ kind: "new_joiners", within_days: 30 }, () => [])).toMatch(/last 30 days/);
  });
  it("validates courses", () => {
    expect(validateCourse({ title: "", description: null, estimatedMinutes: -1 }).map((p) => p.field)).toEqual(["title", "estimatedMinutes"]);
    expect(validateCourse({ title: "Security basics", description: null, estimatedMinutes: 45 })).toEqual([]);
  });
});
