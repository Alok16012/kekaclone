import { describe, expect, it } from "vitest";
import {
  ancestors, autoDue, bandFor, bandsProblem, bpInRange, budgetUse, canAlignTo, combineRatings, distribution, distributionProblem, formProblem, formScore,
  goalInsights, krProgress, krWeightsProblem, matchesFilter, matrixProblem, matrixRowFor, missingAnswers, nextOccurrence, nineBox, objectiveProgress,
  pctText, pipTransition, proposedCtc, reviewersProblem, roundRating, suggestedBp, teamPool, timelinesProblem, weightedProgress, wouldCycle, type Section,
} from "./rules";

const scale = [1, 2, 3, 4, 5].map((v) => ({ value: v, label: String(v) }));
const bands = [{ min: 1, max: 1.99, label: "Low" }, { min: 2, max: 3.49, label: "Solid" }, { min: 3.5, max: 5, label: "High" }];

describe("goal progress", () => {
  it("measures key results from start to target, clamped, including decreasing targets and yes/no", () => {
    expect(krProgress({ metric: "number", start: 0, target: 200, current: 50 })).toBe(25);
    expect(krProgress({ metric: "percent", start: 10, target: 60, current: 80 })).toBe(100);
    expect(krProgress({ metric: "number", start: 100, target: 20, current: 60 })).toBe(50);
    expect(krProgress({ metric: "currency", start: 0, target: 100, current: -5 })).toBe(0);
    expect(krProgress({ metric: "boolean", start: 0, target: 1, current: 1 })).toBe(100);
    expect(krProgress({ metric: "number", start: 5, target: 5, current: 5 })).toBe(100);
  });
  it("weights key results, falling back to equal weights", () => {
    expect(weightedProgress([{ progress: 100, weight: 75 }, { progress: 0, weight: 25 }])).toBe(75);
    expect(weightedProgress([{ progress: 100, weight: 0 }, { progress: 50, weight: 0 }])).toBe(75);
    expect(weightedProgress([])).toBe(0);
  });
  it("rolls up from key results, else aligned children, else the last check-in", () => {
    expect(objectiveProgress({ krs: [{ progress: 40, weight: 50 }, { progress: 60, weight: 50 }], children: [{ progress: 0, weight: 1 }], checkedIn: 90 })).toBe(50);
    expect(objectiveProgress({ krs: [], children: [{ progress: 20, weight: 1 }, { progress: 80, weight: 3 }], checkedIn: 0 })).toBe(65);
    expect(objectiveProgress({ krs: [], children: [], checkedIn: 33.333 })).toBe(33.33);
    expect(objectiveProgress({ krs: [], children: [], checkedIn: null })).toBe(0);
  });
  it("aligns only upwards or sideways and refuses loops", () => {
    expect(canAlignTo("individual", "company")).toBe(true);
    expect(canAlignTo("individual", "individual")).toBe(true);
    expect(canAlignTo("company", "department")).toBe(false);
    const parents = new Map<string, string | null>([["c", "b"], ["b", "a"], ["a", null]]);
    expect(wouldCycle("a", "c", parents)).toBe(true);
    expect(wouldCycle("c", "a", parents)).toBe(false);
    expect(ancestors("c", parents)).toEqual(["b", "a"]);
  });
  it("checks key result weights only when asked", () => {
    expect(krWeightsProblem([50, 40], true)).toMatch(/add up to 90/);
    expect(krWeightsProblem([50, 40], false)).toBeNull();
    expect(krWeightsProblem([0, 0], true)).toBeNull();
    expect(krWeightsProblem([60, 40], true)).toBeNull();
    expect(krWeightsProblem([-1], false)).toMatch(/between/);
  });
  it("summarises goals for managers: status mix, overdue, stagnant", () => {
    const i = goalInsights([
      { status: "on_track", progress: 40, due_date: "2026-01-01", last_check_in: "2026-02-01", created_on: "2025-12-01" },
      { status: "completed", progress: 100, due_date: "2026-01-01", last_check_in: null, created_on: "2025-12-01" },
      { status: "at_risk", progress: 10, due_date: "2026-12-01", last_check_in: "2026-02-25", created_on: "2026-01-01" },
    ], "2026-03-01");
    expect(i.total).toBe(3);
    expect(i.byStatus.on_track).toBe(1);
    expect(i.overdue).toBe(1);
    expect(i.stagnant).toBe(1);
    expect(i.avgProgress).toBe(50);
  });
});

describe("ratings", () => {
  it("rounds per the company setting", () => {
    expect(roundRating(3.26, "half")).toBe(3.5);
    expect(roundRating(3.24, "half")).toBe(3);
    expect(roundRating(3.26, "one_decimal")).toBe(3.3);
    expect(roundRating(3.5, "whole")).toBe(4);
    expect(roundRating(3.256, "none")).toBe(3.26);
  });
  it("finds bands and validates them against the scale", () => {
    expect(bandFor(3.5, bands)).toBe("High");
    expect(bandFor(1.995, bands)).toBeNull();
    expect(bandFor(null, bands)).toBeNull();
    expect(bandsProblem(bands, scale)).toBeNull();
    expect(bandsProblem([{ min: 1, max: 3, label: "A" }, { min: 2.5, max: 5, label: "B" }], scale)).toMatch(/overlaps/);
    expect(bandsProblem([{ min: 0, max: 3, label: "A" }], scale)).toMatch(/outside/);
    expect(bandsProblem([{ min: 1, max: 3, label: "A" }, { min: 4, max: 5, label: "a" }], scale)).toMatch(/Two bands/);
  });
  it("checks the ideal distribution adds to 100 over real bands", () => {
    expect(distributionProblem([{ label: "Low", pct: 20 }, { label: "Solid", pct: 60 }, { label: "High", pct: 20 }], bands)).toBeNull();
    expect(distributionProblem([{ label: "Low", pct: 20 }], bands)).toMatch(/add up to 20/);
    expect(distributionProblem([{ label: "Nope", pct: 100 }], bands)).toMatch(/isn't one/);
  });
  it("scores a form by weighted section averages and lists unanswered items", () => {
    const sections: Section[] = [
      { id: "s1", type: "questions", title: "Work", weight: 60, items: [{ id: "a", text: "Quality", rated: true }, { id: "b", text: "Speed", rated: true }, { id: "c", text: "Anything else?", rated: false, required: true }] },
      { id: "s2", type: "core_values", title: "Values", weight: 40, items: [{ id: "v", text: "Ownership", rated: true }] },
    ];
    const answers = { "s1:a": { rating: 4 }, "s1:b": { rating: 2 }, "s2:v": { rating: 5 } };
    expect(formScore(sections, answers)).toBe(3.8);
    expect(missingAnswers(sections, answers)).toEqual(["Work: Anything else?"]);
    expect(missingAnswers(sections, { ...answers, "s1:c": { comment: " ok " } })).toEqual([]);
    expect(formScore(sections, {})).toBeNull();
    expect(formProblem(sections)).toBeNull();
    expect(formProblem([{ ...sections[0], weight: 50 }])).toMatch(/add up to 50/);
    expect(formProblem([])).toMatch(/at least one/);
  });
  it("combines reviewer ratings by weight, falling back to the manager", () => {
    const w = { self: 0, manager: 70, peer: 30, skip_level: 0 };
    expect(combineRatings({ self: [5], manager: [3], peer: [4, 5] }, w)).toBe(3.45);
    expect(combineRatings({ self: [5], manager: [3] }, w)).toBe(3);
    expect(combineRatings({ self: [5] }, w)).toBe(5);
    expect(combineRatings({}, w)).toBeNull();
  });
  it("builds the curve and the 9-box", () => {
    const d = distribution([1.5, 3, 3.2, 4.8, null, 1.995], bands);
    expect(d.total).toBe(5);
    expect(d.unbanded).toBe(1);
    expect(d.bands.map((b) => b.count)).toEqual([1, 2, 1]);
    expect(d.bands[1].pct).toBe(40);
    expect(nineBox(4.8, 3, scale)).toEqual({ perf: 3, potential: 3 });
    expect(nineBox(2.2, 1, scale)).toEqual({ perf: 1, potential: 1 });
    expect(nineBox(3, 2, scale)).toEqual({ perf: 2, potential: 2 });
    expect(nineBox(null, 2, scale)).toBeNull();
  });
});

describe("cycles", () => {
  it("keeps stage dates in order inside a valid period", () => {
    expect(timelinesProblem({ self_due: "2026-04-10", manager_due: "2026-04-20" }, "2026-01-01", "2026-03-31")).toBeNull();
    expect(timelinesProblem({ self_due: "2026-04-10", manager_due: "2026-04-05" }, "2026-01-01", "2026-03-31")).toMatch(/Manager reviews due can't be before Self/);
    expect(timelinesProblem({}, "2026-03-31", "2026-01-01")).toMatch(/must end after/);
  });
  it("needs some reviewer and sane peer limits", () => {
    const base = { self: false, manager: false, skip_level: false, peer: { enabled: false, min: 0, max: 3, nominated_by: "employee" as const, needs_approval: true } };
    expect(reviewersProblem(base)).toMatch(/at least one/);
    expect(reviewersProblem({ ...base, manager: true })).toBeNull();
    expect(reviewersProblem({ ...base, peer: { ...base.peer, enabled: true, min: 4, max: 2 } })).toMatch(/minimum/);
  });
  it("maps employees by filters with explicit include / exclude", () => {
    const e = { id: "e1", department_id: "d1", location_id: "l1", joining_date: "2025-06-01" };
    expect(matchesFilter(e, {})).toBe(true);
    expect(matchesFilter(e, { department_ids: ["d2"] })).toBe(false);
    expect(matchesFilter(e, { department_ids: ["d2"], include_ids: ["e1"] })).toBe(true);
    expect(matchesFilter(e, { exclude_ids: ["e1"], include_ids: ["e1"] })).toBe(false);
    expect(matchesFilter(e, { joined_before: "2025-05-01" })).toBe(false);
  });
  it("triggers automatic reviews on the day (with a 30-day catch-up)", () => {
    const p = { joining_date: "2026-01-01", probation_end_date: "2026-07-01" };
    expect(autoDue({ trigger: "joining", days: 90 }, p, "2026-04-01")).toBe(true);
    expect(autoDue({ trigger: "joining", days: 90 }, p, "2026-03-31")).toBe(false);
    expect(autoDue({ trigger: "joining", days: 90 }, p, "2026-06-01")).toBe(false);
    expect(autoDue({ trigger: "probation_end", days: 15 }, p, "2026-06-16")).toBe(true);
    expect(autoDue({ trigger: "probation_end", days: 15 }, { ...p, probation_end_date: null }, "2026-06-16")).toBe(false);
  });
  it("schedules the next 1:1, clamping month ends", () => {
    expect(nextOccurrence(new Date("2026-01-05T05:00:00Z"), "weekly").toISOString()).toBe("2026-01-12T05:00:00.000Z");
    expect(nextOccurrence(new Date("2026-01-05T05:00:00Z"), "biweekly").toISOString()).toBe("2026-01-19T05:00:00.000Z");
    expect(nextOccurrence(new Date("2026-01-31T05:00:00Z"), "monthly").toISOString()).toBe("2026-02-28T05:00:00.000Z");
  });
  it("only moves open PIPs to an outcome", () => {
    expect(pipTransition("active", "passed")).toBe(true);
    expect(pipTransition("extended", "failed")).toBe(true);
    expect(pipTransition("passed", "failed")).toBe(false);
    expect(pipTransition("active", "active")).toBe(false);
  });
});

describe("compensation", () => {
  const matrix = [
    { rating_min: 1, rating_max: 2.49, increment_pct_min: 0, increment_pct_max: 3 },
    { rating_min: 2.5, rating_max: 3.99, increment_pct_min: 5, increment_pct_max: 10, increment_pct_default: 7.5 },
    { rating_min: 4, rating_max: 5, increment_pct_min: 10, increment_pct_max: 20 },
  ];
  it("validates the matrix", () => {
    expect(matrixProblem(matrix)).toBeNull();
    expect(matrixProblem([...matrix, { rating_min: 4.5, rating_max: 5, increment_pct_min: 1, increment_pct_max: 2 }])).toMatch(/overlap/);
    expect(matrixProblem([{ rating_min: 1, rating_max: 2, increment_pct_min: 5, increment_pct_max: 3 }])).toMatch(/lowest first/);
    expect(matrixProblem([{ rating_min: 1, rating_max: 2, increment_pct_min: 1, increment_pct_max: 3, increment_pct_default: 4 }])).toMatch(/inside/);
  });
  it("suggests and bounds increments from the rating", () => {
    expect(suggestedBp(matrixRowFor(3.2, matrix))).toBe(750);
    expect(suggestedBp(matrixRowFor(4.5, matrix))).toBe(1500);
    expect(suggestedBp(matrixRowFor(null, matrix))).toBe(0);
    expect(bpInRange(1000, matrixRowFor(3, matrix))).toBe(true);
    expect(bpInRange(1100, matrixRowFor(3, matrix))).toBe(false);
    expect(bpInRange(0, null)).toBe(true);
    expect(bpInRange(100, null)).toBe(false);
  });
  it("computes new CTC in whole rupees, budget use and team pools", () => {
    expect(proposedCtc(1_200_000_00, 1000)).toBe(1_320_000_00);
    expect(proposedCtc(1_000_001_00, 333)).toBe(1_033_301_00);
    expect(budgetUse([{ current: 100, proposed: 110 }, { current: 50, proposed: 50 }])).toBe(10);
    expect(teamPool(1_000_000, 300, 1200)).toBe(250_000);
    expect(teamPool(1_000_000, 300, 0)).toBe(0);
    expect(pctText(750)).toBe("7.5%");
    expect(pctText(1000)).toBe("10%");
    expect(pctText(1234)).toBe("12.34%");
  });
});
