import { describe, expect, it } from "vitest";
import { canShow, csvCell, dueTransition, enps, nextRoundStart, schedule, summarize, validateAnswer, validateAnswers, validateQuestion, validateSchedule, type Question } from "./rules";

const q = (type: Question["type"], extra: Partial<Question> = {}): Question => ({ id: type, type, prompt: "Q", required: true, options: null, ...extra });

describe("questions", () => {
  it("choice questions need two distinct options", () => {
    expect(validateQuestion({ type: "single", prompt: "Pick", required: true, options: { choices: ["A", " A ", ""] } })).toMatchObject({ ok: false, field: "choices" });
    expect(validateQuestion({ type: "multi", prompt: "Pick", required: true, options: { choices: ["A", "B", "A"] } })).toEqual({ ok: true, options: { choices: ["A", "B"] } });
  });
  it("scales and ratings have bounded sizes with defaults", () => {
    expect(validateQuestion({ type: "opinion_scale", prompt: "x", required: true })).toMatchObject({ ok: true, options: { max: 5, left: "Strongly disagree" } });
    expect(validateQuestion({ type: "opinion_scale", prompt: "x", required: true, options: { max: 6 } })).toMatchObject({ ok: false });
    expect(validateQuestion({ type: "rating", prompt: "x", required: true, options: { max: 11 } })).toMatchObject({ ok: false });
    expect(validateQuestion({ type: "nps", prompt: " ", required: true })).toMatchObject({ ok: false, field: "prompt" });
    expect(validateQuestion({ type: "date", prompt: "When?", required: false })).toEqual({ ok: true, options: null });
  });
});

describe("answers (all 10 types)", () => {
  const choices = { choices: ["Red", "Blue", "Green"] };
  it("validates and normalises each type", () => {
    expect(validateAnswer(q("short_text"), "  hi ")).toEqual({ ok: true, value: "hi" });
    expect(validateAnswer(q("short_text"), "x".repeat(301)).ok).toBe(false);
    expect(validateAnswer(q("long_text"), "x".repeat(3000)).ok).toBe(true);
    expect(validateAnswer(q("dropdown", { options: choices }), "Blue")).toEqual({ ok: true, value: "Blue" });
    expect(validateAnswer(q("single", { options: choices }), "Pink").ok).toBe(false);
    expect(validateAnswer(q("multi", { options: choices }), ["Green", "Red", "Red"])).toEqual({ ok: true, value: ["Red", "Green"] });
    expect(validateAnswer(q("multi", { options: choices }), ["Pink"]).ok).toBe(false);
    expect(validateAnswer(q("yes_no"), "yes").ok).toBe(true);
    expect(validateAnswer(q("yes_no"), "maybe").ok).toBe(false);
    expect(validateAnswer(q("nps"), 0)).toEqual({ ok: true, value: 0 });
    expect(validateAnswer(q("nps"), 11).ok).toBe(false);
    expect(validateAnswer(q("opinion_scale", { options: { max: 7 } }), 7).ok).toBe(true);
    expect(validateAnswer(q("opinion_scale", { options: { max: 7 } }), 0).ok).toBe(false);
    expect(validateAnswer(q("rating", { options: { max: 5 } }), "4")).toEqual({ ok: true, value: 4 });
    expect(validateAnswer(q("rating", { options: { max: 5 } }), 4.5).ok).toBe(false);
    expect(validateAnswer(q("date"), "2026-02-28").ok).toBe(true);
    expect(validateAnswer(q("date"), "2026-02-30").ok).toBe(false);
  });
  it("required vs optional", () => {
    expect(validateAnswer(q("short_text"), "").ok).toBe(false);
    expect(validateAnswer(q("short_text", { required: false }), "  ")).toEqual({ ok: true, value: null });
    expect(validateAnswer(q("multi", { required: false, options: choices }), [])).toEqual({ ok: true, value: null });
  });
  it("collects per-question errors and drops unknown ids", () => {
    const r = validateAnswers([q("nps"), q("yes_no", { required: false })], { nps: 9, other: "x" });
    expect(r).toEqual({ ok: true, answers: { nps: 9 }, errors: {} });
    expect(validateAnswers([q("nps")], {}).errors).toHaveProperty("nps");
  });
});

describe("schedule and pulse rounds", () => {
  it("validates dates", () => {
    expect(validateSchedule({ startOn: "2026-11-01", endOn: null, recurrence: "none" }, "2026-11-03")).toMatch(/past/);
    expect(validateSchedule({ startOn: "2026-11-10", endOn: "2026-11-09", recurrence: "none" }, "2026-11-03")).toMatch(/after/);
    expect(validateSchedule({ startOn: null, endOn: null, recurrence: "monthly" }, "2026-11-03")).toBeNull();
  });
  it("next round dates (month ends clamp)", () => {
    expect(nextRoundStart("2026-11-03", "weekly")).toBe("2026-11-10");
    expect(nextRoundStart("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(nextRoundStart("2026-11-30", "quarterly")).toBe("2027-02-28");
    expect(nextRoundStart("2026-11-03", "none")).toBeNull();
  });
  it("decides what the scheduler does", () => {
    const s = schedule({ startOn: "2026-11-05" });
    expect(dueTransition("draft", s, "2026-11-04")).toBeNull();
    expect(dueTransition("draft", s, "2026-11-05")).toBe("launch");
    expect(dueTransition("draft", schedule({}), "2026-11-05")).toBeNull();
    expect(dueTransition("live", schedule({ roundStartedOn: "2026-11-01", recurrence: "weekly" }), "2026-11-07")).toBeNull();
    expect(dueTransition("live", schedule({ roundStartedOn: "2026-11-01", recurrence: "weekly" }), "2026-11-08")).toBe("next_round");
    expect(dueTransition("live", schedule({ roundStartedOn: "2026-11-01", recurrence: "weekly", endOn: "2026-11-07" }), "2026-11-08")).toBe("close");
    expect(dueTransition("closed", schedule({ startOn: "2026-01-01" }), "2026-11-08")).toBeNull();
  });
});

describe("results", () => {
  it("anonymous results need the threshold (never below 3)", () => {
    expect(canShow(true, 4, 5)).toBe(false);
    expect(canShow(true, 5, 5)).toBe(true);
    expect(canShow(true, 2, 1)).toBe(false);
    expect(canShow(false, 1, 5)).toBe(true);
  });
  it("eNPS", () => {
    expect(enps([10, 9, 8, 7, 6, 0])).toEqual({ n: 6, promoters: 2, passives: 2, detractors: 2, score: 0 });
    expect(enps([10, 10, 9, 3])).toMatchObject({ score: 50 });
    expect(enps([]).score).toBeNull();
  });
  it("summaries per type", () => {
    const s = summarize(q("multi", { options: { choices: ["A", "B"] } }), [["A"], ["A", "B"], null]);
    expect(s).toEqual({ kind: "choices", total: 2, counts: [{ label: "A", count: 2 }, { label: "B", count: 1 }] });
    const n = summarize(q("nps"), [10, 6, 9, null]);
    expect(n.kind === "scale" && n.average).toBe(8.3);
    expect(n.kind === "scale" && n.enps?.score).toBe(33);
    expect(summarize(q("yes_no"), ["yes", "no", "yes"])).toMatchObject({ counts: [{ label: "Yes", count: 2 }, { label: "No", count: 1 }] });
    expect(summarize(q("long_text"), ["b", "a"])).toEqual({ kind: "text", total: 2, answers: ["a", "b"] });
    expect(summarize(q("date"), ["2026-11-03", "2026-11-20", "2026-12-01"])).toMatchObject({ counts: [{ label: "2026-11", count: 2 }, { label: "2026-12", count: 1 }] });
  });
  it("CSV cells are quoted and formula-safe", () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("=HYPERLINK(1)")).toBe(`"'=HYPERLINK(1)"`);
    expect(csvCell(["A", "B"])).toBe('"A; B"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(7)).toBe('"7"');
  });
});
